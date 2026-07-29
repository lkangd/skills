# Claude Code Built-In Auto-Allowed Commands

Claude Code auto-allows these commands without prompting, so an exact `permissions.allow` rule fully covered by this list will never fire again and should be classified `Delete` with reason `covered by built-in auto-allow`.

This is a snapshot and may drift across Claude Code versions. The upstream source of truth is the Claude Code repository: `src/tools/BashTool/readOnlyValidation.ts` (`READONLY_COMMANDS`, `READONLY_NOARGS`, `READONLY_EXACT`, `COMMAND_ALLOWLIST`) and `src/utils/shell/readOnlyCommandValidation.ts` (`GIT_READ_ONLY_COMMANDS`, `GH_READ_ONLY_COMMANDS`, `DOCKER_READ_ONLY_COMMANDS`, `RIPGREP_READ_ONLY_COMMANDS`, `PYRIGHT_READ_ONLY_COMMANDS`). When a command's coverage is uncertain, keep the rule and say so instead of guessing.

## Always auto-allowed (any args)

`cal`, `uptime`, `cat`, `head`, `tail`, `wc`, `stat`, `strings`, `hexdump`, `od`, `nl`, `id`, `uname`, `free`, `df`, `du`, `locale`, `groups`, `nproc`, `basename`, `dirname`, `realpath`, `cut`, `paste`, `tr`, `column`, `tac`, `rev`, `fold`, `expand`, `unexpand`, `fmt`, `comm`, `cmp`, `numfmt`, `readlink`, `diff`, `true`, `false`, `sleep`, `which`, `type`, `expr`, `seq`, `tsort`, `pr`, `echo`, `ls`, `cd`.

## Auto-allowed with zero args only

`pwd`, `whoami`, `alias`.

## Auto-allowed exact forms

`claude -h`, `claude --help`, `node -v`, `node --version`, `python --version`, `python3 --version`, `ip addr`.

## Auto-allowed with safe flags only (validated)

`xargs`, `file`, `sed` (read-only expressions), `sort`, `man`, `help`, `netstat`, `ps`, `base64`, `grep`, `egrep`, `fgrep`, `sha256sum`, `sha1sum`, `md5sum`, `tree`, `date`, `hostname`, `lsof`, `pgrep`, `tput`, `ss`, `fd`, `fdfind`, `aki`, `rg`, `jq`, `uniq`, `history`, `arch`, `ifconfig`, `pyright`, `find` (blocks `-delete`/`-exec`/`-execdir`/`-ok`/`-okdir`/`-fprint*`/`-fls`/`-files0-from`), `printf` (blocks any `-flag`), `test` (blocks `-v`/`-R`/`-a`/`-o`).

Flag validation matters: a rule is only dead weight when its observed flags fall inside the safe subset. `sed -i`, `find -delete`, and similar mutating forms are not covered.

## All git read-only subcommands

`git status`, `git log`, `git diff`, `git show`, `git blame`, `git grep`, `git branch`, `git tag`, `git remote`, `git ls-files`, `git ls-remote`, `git config --get`, `git rev-parse`, `git describe`, `git stash list`, `git reflog`, `git shortlog`, `git cat-file`, `git for-each-ref`, `git worktree list`, and similar. This includes invocations routed through `git -C <path>` and absolute paths such as `/usr/bin/git`.

## All gh read-only subcommands

`gh pr view`, `gh pr list`, `gh pr diff`, `gh pr checks`, `gh pr status`, `gh issue view`, `gh issue list`, `gh issue status`, `gh run view`, `gh run list`, `gh workflow list`, `gh workflow view`, `gh repo view`, `gh release view`, `gh release list`, `gh api` (GET), `gh auth status`, and similar.

## Docker read-only subcommands

`docker ps`, `docker images`, `docker logs`, `docker inspect`.
