import type { EngineInterface, Register } from 'claude-code'

// Redraws a desktop reply that cites files so a click on a file reference
// opens it in VS Code; scripts/open-in-vscode.sh decides which window.

// The most text a Markdown element draws; a longer reply keeps its own drawing.
const MAX_TEXT = 10000
const MAX_LINKS = 256

// Code spans and fences: their text is left as written.
const CODE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/
// [label](target), not an image; the target without spaces, its parentheses
// in pairs as in "app/(marketing)/page.tsx".
const LINK = /(!?)\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g
// https:, mailto:, ...; "CLAUDE.md:3" is a file and its line.
const SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i
// "a.ts", "a.ts:42", "a.ts:42:7", "a.ts:42-50", "a.ts#L42", "a.ts#L42C7-L50"
const LOCATION = /^(.+?)(?::(\d+)(?::(\d+))?(?:-\d+)?|#L(\d+)(?:C(\d+))?(?:-L?\d+)?)?$/
// VS Code opens these as a workspace rather than as a file, also with `-g`.
const WORKSPACE_FILE = /\.code-workspace$/i

type FileRef = { path: string; line: number; column: number }

const decode = (text: string): string => {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

const normalize = (path: string): string => {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

const toFileRef = (target: string, cwd: string): FileRef | undefined => {
  let spelled = target
  if (spelled.startsWith('file://')) spelled = spelled.slice('file://'.length)
  else if (SCHEME.test(spelled) || spelled.startsWith('#')) return undefined

  const match = LOCATION.exec(decode(spelled))
  const [, path, line, column, lineL, columnC] = match ?? []
  if (!path) return undefined

  return {
    path: normalize(path.startsWith('/') ? path : `${cwd}/${path}`),
    line: Number(line ?? lineL ?? 1),
    column: Number(column ?? columnC ?? 1),
  }
}

const toHref = ({ path, line, column }: FileRef): string => {
  const encoded = encodeURI(path).replace(/[()#?]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `file://${encoded}#L${line}C${column}`
}

const fromHref = (href: string): FileRef | undefined => {
  const url = new URL(href)
  if (url.protocol !== 'file:') return undefined
  const location = /^#L(\d+)C(\d+)$/.exec(url.hash)
  return {
    path: decode(url.pathname),
    line: Number(location?.[1] ?? 1),
    column: Number(location?.[2] ?? 1),
  }
}

const openInVSCode = async ($: EngineInterface, href: string): Promise<void> => {
  const ref = fromHref(href)
  if (!ref) return

  try {
    const ran = await $.process.run(
      ['bash', `${$.plugin.root}/scripts/open-in-vscode.sh`, ref.path, String(ref.line), String(ref.column)],
      { timeoutMs: 20000 },
    )
    if (ran.exitCode !== 0) {
      $.ui.toast(`Could not open in VS Code: ${ran.stderr.trim() || `exit ${ran.exitCode}`}`)
    }
  } catch (error) {
    $.ui.toast(`Could not open in VS Code: ${String(error)}`)
  }
}

// A regular file VS Code opens as a file: a folder or a workspace file would
// open as a workspace in a new window, and a device or a pipe would hang it.
const isOpenableFile = async ($: EngineInterface, path: string): Promise<boolean> => {
  if (WORKSPACE_FILE.test(path)) return false
  try {
    return (await $.fs.stat(path)).kind === 'file'
  } catch {
    return false
  }
}

// The slash command that installs the bundled VS Code extension, so that the
// person need not find this plugin's folder.
const INSTALL_COMMAND = 'open-in-vscode-install-extension'

export const register: Register = on => {
  // Whether each absolute path is a file to open, so any other link keeps its own behaviour.
  const openable = new Map<string, boolean>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: INSTALL_COMMAND,
      description: 'Install the Claude Open Bridge VS Code extension, for the Markdown Preview jump',
    })
    return next(e)
  })

  on('command.run', { command: INSTALL_COMMAND }, async $ => {
    try {
      const ran = await $.process.run(
        ['bash', `${$.plugin.root}/scripts/install-vscode-extension.sh`],
        { timeoutMs: 120000 },
      )
      const output = `${ran.stdout}\n${ran.stderr}`.trim()
      return { text: ran.exitCode === 0 ? output : `${output}\n(exit ${ran.exitCode})` }
    } catch (error) {
      return { text: `Could not run the install script: ${String(error)}` }
    }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || !e.props.text.includes('](')) return next(e)

    const cwd = await $.session.cwd()
    const hrefs = new Set<string>()
    const pieces: string[] = []

    for (const [index, piece] of e.props.text.split(CODE).entries()) {
      if (index % 2 === 1) {
        pieces.push(piece)
        continue
      }

      let rewritten = ''
      let last = 0
      for (const match of piece.matchAll(LINK)) {
        const [whole, bang, label, target] = match
        const ref = bang || !target ? undefined : toFileRef(target, cwd)
        if (!ref) continue

        if (!openable.has(ref.path)) openable.set(ref.path, await isOpenableFile($, ref.path))
        if (!openable.get(ref.path)) continue

        const href = toHref(ref)
        hrefs.add(href)
        rewritten += `${piece.slice(last, match.index)}[${label}](${href})`
        last = match.index + whole.length
      }
      pieces.push(rewritten + piece.slice(last))
    }

    const text = pieces.join('')
    if (hrefs.size === 0 || hrefs.size > MAX_LINKS || text.length > MAX_TEXT) return next(e)

    const { Markdown } = $.ui.resolve(e)
    return (
      <Markdown
        key="open-in-vscode"
        text={text}
        pressableLinks={[...hrefs]}
        onLinkPress={link => openInVSCode($, link.href)}
      />
    )
  })
}
