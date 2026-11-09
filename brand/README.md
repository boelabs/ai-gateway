# Brand assets

The AI Gateway mark is a suspension bridge. AI Gateway is a Boelabs product and goes by its full name,
Boelabs AI Gateway, but it carries its own mark: the Boelabs isotipo belongs to Boelabs, not to one of
the things Boelabs builds.

Every file here comes from the Boelabs brand kit (`products/ai-gateway`).

| File | What it is |
|---|---|
| `ai-gateway-logo.svg` | The logotype (mark and wordmark) in `currentColor`. It is the kit's tight cut (`ai-gateway-logo-horizontal-black-tight.svg`) with only the fill changed. Both apps inline the same paths and transforms as `AiGatewayLogo`, wherever the product is named. |
| `ai-gateway-logo-light.png` | The logotype in black, 800px wide, resized from the kit's tight PNG. The README's heading on light backgrounds. |
| `ai-gateway-logo-dark.png` | The same logotype in white, for dark backgrounds. |
| `ai-gateway-mark.svg` | The mark alone in `currentColor`, with the viewBox cropped to the artwork (224 × 160). |
| `ai-gateway-mark-light.png` | Black ink on transparency, 512px wide, cut from the kit's tight logo PNG. For light backgrounds. |
| `ai-gateway-mark-dark.png` | The same mark in white. For dark backgrounds. |
| `ai-gateway-isotype-source.svg` | The kit's isotype as delivered, the source of truth for the mark. |

## One colour, two themes

The mark is a single colour on transparency. That is why every surface below can theme it without a
second file. In the apps it is inline SVG filled with `currentColor`, so it takes the colour of the
text around it. In a browser tab the SVG carries its own `prefers-color-scheme` rule. The README
picks a file with `<picture>` because GitHub has no CSS to lend it.

Anything the operating system composites, such as an installed icon or an iOS home screen, uses the
kit's app icon instead: the white mark on its dark gradient tile. The manifest icons are the kit's
rounded tiles as delivered. `apple-icon.png` is the kit's full-bleed iOS square resized to 180px,
because iOS applies its own mask and paints transparent corners black. `favicon.ico` is the kit's
own.

## Regenerating

Each app's `icon.svg` is the isotype's single path in its own 256 square, with the theme rule added.
The `AiGatewayLogo` components keep the kit's group transforms rather than folding them into the
paths. They draw exactly what the kit draws and need no rasterised comparison.

The kit also has a normal cut. It is padded to a height shared by every Boelabs brand, so logos shown
side by side at one height have letters of one size. The apps show the logotype alone, against an
edge, which is what the kit's guide reserves the tight cut for.

Redo these files only from the kit.
