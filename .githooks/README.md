# Repository Git hooks

Enable the hooks once per clone from the repository root.

```sh
git config --local core.hooksPath .githooks
```

The pre-commit hook uses Python 3.9 or newer to check plugin installation commands
and packaging in the proposed commit. It uses the publishing URL in the root
`package.json`. Run `python3 scripts/lint-plugin-install.py` to check your working
copy before staging.
