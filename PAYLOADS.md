# Payloads

## PS4 12.00 - 14.02

Nothing to add. The repo includes:

- `afterglow/goldhen.bin` - GoldHEN, used by default
- `afterglow/hen.bin` - ps4-hen
- `afterglow/patchset-1402.bin` - the 14.02 kernel patch set

Pick the payload on the run page or with **Choose payload** from the menu.

## PS4 9.00 - 11.52

The legacy Wobkot chain needs a raw payload at:

```
src/ps4/payload.bin
```

It is not bundled because the right payload depends on the firmware. Drop a
compatible payload there and reload the page. If the file is missing, the page
now stops before the kernel exploit and links back here.

If you host on GitHub Pages, the file is git-ignored; force-add it in your fork:

```powershell
git add -f src/ps4/payload.bin
```

Sources for a compatible payload include the GoldHEN releases and ps4-hen
builds for your firmware. Follow their own instructions and licenses.

## PS5

The upstream Wobkot PS5 chain expects:

```
src/ps5/elfldr.elf
src/ps5/kexp.bin
```

These are not bundled. The PS5 path is kept as upstream provided it; PS5
support depends on those files and the matching firmware offsets.

If you host on GitHub Pages, force-add them in your fork:

```powershell
git add -f src/ps5/elfldr.elf src/ps5/kexp.bin
```

## Licensing

Payloads are third-party software. GoldHEN, ps4-hen and any payload you add
keep their own licenses; see `THIRD_PARTY.md`.
