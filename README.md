## cdn

A pre-commit hook regenerates `index.html` (from `generate-index.py`) and stages it,
so every commit keeps the root directory listing in sync.

```sh
git config core.hooksPath .githooks
```
