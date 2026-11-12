# Sonora · Sleeve-first UI direction

This is the implementation brief for Direction 01 in [`ui-concepts.html`](ui-concepts.html). It is a **design direction**, not a new theme or a literal reproduction of the illustrative phone mock.

## Thesis

A familiar song is the front door. The current or last-played **real cover** and its title should be the first visual anchor on home, with one clear resume action. The personal station follows as the next path, rather than competing with a generic decorative hero. Search, library, artist, albums, queues and rooms should feel like the same music collection, not separate dashboards.

## Tokens to retain and extend

| Role | Source | Use |
| --- | --- | --- |
| Ground | `--bg:#111215` | Quiet stage behind artwork; avoid a new light or gradient theme. |
| Surface | `--panel`, `--card` | Raised sleeves, track rows, player and sheets. |
| Ink | `--white`, `--text-2`, `--muted` | Strong track title, softer byline, legible metadata. |
| Action | `--accent:#ff997b` | Play, active state and progress only; never a decorative wash everywhere. |
| Type | self-hosted Inter | Large but concise title, compact readable track metadata, utility labels used only when informative. |
| Shape | existing 8/12/16/22px radius scale | Art keeps its own cover shape, controls share existing radii. |

**Signature:** the real artwork of the song you can resume, treated as a sleeve, gives the home page a personal identity. With no prior listen, the hero should clearly invite the first song without inventing one or breaking the empty state.

## Layout intent

```
PHONE                                DESKTOP
brand + account                      navigation │ page / featured sleeve │ now-playing rail
last song / continue                 navigation │ recent records         │ queue
back in rotation                     navigation │ station + collection   │
station / library                    full-width persistent player
mini player + primary nav
```

- Treat track artwork as content, not wallpaper; keep title, artist and actions readable over a dark scrim when art is used as a background.
- Recent tracks need cover, title and one obvious play target; no duplicate full-size liked/recent shelf on home when the library and nav already reach them.
- Preserve station, radio, library and admin access. Reduce visual competition rather than silently deleting features.
- Preserve the existing cross-device resume labels and playhead semantics, queue actions, focus indicators, touch targets, safe-area math and reduced-motion support.
- The adjacent room, install and notification surfaces inherit the same restrained material language, not a rival palette.

## Rejected defaults

A generic abstract orb or poster gradient as the featured content; repeated all-caps decorative labels; an indiscriminate grid of equally weighted cards; an always-visible install pitch overpowering the track; fabricated cover art where real catalogue imagery exists.

## Verification

Test the existing UI contracts (`flows`, `ux`, `safe-area`, `library`, `layout`, `pwa`, `rooms-browser`) and inspect real Chromium screenshots at 390px and desktop widths. A mock passing as CSS is not enough: images, text wrapping, player overlap, empty states and touch targets must work with real app data.
