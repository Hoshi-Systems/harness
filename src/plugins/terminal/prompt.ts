import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { hoshiFile } from '../../kernel/index.js'

/**
 * ── The prompt a Hoshi shell opens with ──────────────────────────────────────
 *
 * A machine's shell had the stock one — `user@host dir %` in the terminal's
 * plain foreground — which is a strange thing to hand somebody on a surface
 * whose entire purpose is watching work happen. It says nothing you cannot see,
 * and it says nothing you actually want: which branch, and whether the last
 * thing you ran worked.
 *
 * This is that prompt, and deliberately NOT oh-my-zsh. That framework is a
 * package, a plugin loader and a measurable startup cost, on an image that does
 * not even ship zsh; what people want from it is the LOOK — a coloured path, a
 * branch, a caret that goes red when something failed — and that is fifteen
 * lines of shell with no dependency and no startup to speak of.
 *
 * Two rules it follows:
 *
 *   - **The person's own configuration is sourced FIRST**, whole. Their
 *     aliases, their PATH, their tools, their functions — all of it, exactly as
 *     if we were not here. Only the prompt is ours, and only after theirs has
 *     had its say.
 *   - **`HOSHI_PROMPT=0` turns it off** and leaves whatever they set. It is
 *     their machine; this is an opinion, not a policy.
 *
 * The colours are `%F{blue}`-style names, not hex, so they resolve through the
 * SIXTEEN the client renders (`packages/ui/app/lib/terminal.ts`) rather than
 * fighting them. A person's own terminal, over SSH, gets their own sixteen —
 * which is the correct answer there too.
 *
 **/

/** Where the rc files live. Inside the machine's own store, never in the
 *  person's home: writing a dotfile into somebody's `~` to style a prompt is
 *  the kind of help nobody asked for. */
const SHELL_DIR = () => hoshiFile('shell')

/**
 *
 * zsh. `vcs_info` is the shell's own git integration — one `git` call per
 * prompt against an already-warm process, rather than the subprocess pile-up a
 * hand-rolled `$(git ...)` in PROMPT becomes.
 *
 * Branch only, no dirty marker: `check-for-changes` runs the equivalent of
 * `git status` on every prompt, which is imperceptible in a small repo and a
 * visible stall in a large one. A prompt that hitches is worse than a prompt
 * that tells you less.
 *
 **/
const ZSHRC = `# Written by Hoshi. Edited here, it is overwritten on the next shell —
# put your own configuration in ~/.zshrc, which is sourced first, below.
[ -f "\${HOME}/.zshrc" ] && source "\${HOME}/.zshrc"

# ZDOTDIR is how the prompt gets in, and it moves more than the prompt: zsh's
# startup files resolve against it, so \`/etc/zshrc\`'s
# \`HISTFILE=\${ZDOTDIR:-\$HOME}/.zsh_history\` quietly sends a person's shell
# history into Hoshi's store instead of their own — invisible until the day they
# look for a command they ran here. Put it back, unless they chose it themselves.
[[ "\$HISTFILE" == "\$ZDOTDIR/"* ]] && HISTFILE="\${HOME}/.zsh_history"

if [ "\${HOSHI_PROMPT:-1}" != "0" ]; then
  autoload -Uz vcs_info
  zstyle ':vcs_info:git:*' formats ' %F{magenta}%b%f'
  zstyle ':vcs_info:git:*' actionformats ' %F{magenta}%b%f %F{yellow}%a%f'
  precmd_functions+=(vcs_info)
  setopt prompt_subst
  # %3~ rather than %~: the dock's terminal is a column beside a conversation,
  # not a full-width window, and a 70-character path wraps every single prompt
  # there. Three trailing components is what you actually read.
  PROMPT='%F{blue}%3~%f\${vcs_info_msg_0_} %(?.%F{green}.%F{red})❯%f '
  RPROMPT=''
fi
`

/**
 *
 * bash — the machine image's shell, since it ships no zsh. `\\[` / `\\]` around
 * every escape is not decoration: without them bash counts the colour codes as
 * printable width, and a long command line starts overwriting its own prompt.
 *
 **/
const BASHRC = `# Written by Hoshi. Edited here, it is overwritten on the next shell —
# put your own configuration in ~/.bashrc, which is sourced first, below.
[ -f "\${HOME}/.bashrc" ] && source "\${HOME}/.bashrc"

if [ "\${HOSHI_PROMPT:-1}" != "0" ]; then
  # The last three components, the trim zsh gets from %3~. Done by hand rather
  # than with PROMPT_DIRTRIM, which is bash 4 and the Mac a developer runs this
  # on still ships bash 3.2 — it would have worked on the machine image and
  # silently done nothing on their own laptop, which is the worst of both.
  # Pure parameter expansion, so it costs no subprocess per prompt.
  __hoshi_dir() {
    local dir="\${PWD/#\$HOME/\~}"
    local head="\${dir%/*/*/*}"
    if [ -n "\$head" ] && [ "\$head" != "\$dir" ]; then printf '…%s' "\${dir#\$head}"
    else printf '%s' "\$dir"; fi
  }
  __hoshi_branch() {
    local branch
    branch=\$(git symbolic-ref --short HEAD 2>/dev/null) || return 0
    printf ' \\001\\033[35m\\002%s\\001\\033[0m\\002' "\$branch"
  }
  __hoshi_caret() {
    if [ "\$1" -eq 0 ]; then printf '\\001\\033[32m\\002❯\\001\\033[0m\\002'
    else printf '\\001\\033[31m\\002❯\\001\\033[0m\\002'; fi
  }
  PS1='\\[\\033[34m\\]$(__hoshi_dir)\\[\\033[0m\\]$(__hoshi_branch) $(__hoshi_caret $?) '
fi
`

/**
 *
 * Lay the rc files down and hand back how to start each shell with them.
 *
 * zsh takes a DIRECTORY (`ZDOTDIR`) and bash a FILE (`--rcfile`), which is why
 * this returns both an env overlay and an argv rather than one of them.
 * A shell neither of them recognizes gets nothing added and starts exactly as
 * it would have — an unknown shell is not a shell to experiment on.
 *
 **/
export async function promptSetup(shell: string): Promise<{ env: Record<string, string>; args: string[] }> {
  const name = shell.split('/').pop() ?? shell
  const dir = SHELL_DIR()

  try {
    if (name === 'zsh') {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, '.zshrc'), ZSHRC, 'utf8')
      return { env: { ZDOTDIR: dir }, args: [] }
    }
    if (name === 'bash') {
      await mkdir(dir, { recursive: true })
      const rc = path.join(dir, 'bashrc')
      await writeFile(rc, BASHRC, 'utf8')
      /** `-i` because `--rcfile` is only read by an interactive shell, and a
       *  PTY's shell is interactive whether or not bash worked it out. */
      return { env: {}, args: ['--rcfile', rc, '-i'] }
    }
  } catch {
    /** An unwritable store costs a prompt, never a shell. */
  }
  return { env: {}, args: [] }
}
