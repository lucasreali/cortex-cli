# Vendored license texts

`scripts/notices.ts` builds `THIRD-PARTY-NOTICES.md` from the license file each
bundled package ships. A few packages declare a license in `package.json` and
ship no text at all; their text lives here instead, one `<package>.txt` per
package, and the generator fails loudly when a package has neither — so a
missing notice is a build error rather than a silent omission.

| File | Source |
|---|---|
| `onnxruntime-common.txt` | `LICENSE` of [microsoft/onnxruntime](https://github.com/microsoft/onnxruntime), the repository both npm packages are published from |
| `onnxruntime-web.txt` | same |

A scoped package would be spelled `@scope__name.txt`.
