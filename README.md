## cdn

A pre-commit hook regenerates and stages `index.html` and `_artifacts.html` from
`generate-index.py`. The latter lists the 20 newest publishable files in `artifacts/`
and is available at `https://kraxen72.github.io/cdn/_artifacts.html`; it is absent
from the main listing. `.nojekyll` lets GitHub Pages serve the underscore-prefixed file.

```sh
git config core.hooksPath .githooks
```
