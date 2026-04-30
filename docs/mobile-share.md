# Mobile share → Memoria

Memoria registers itself as a Web Share Target so the OS share sheet can hand a
URL straight to the server, which queues the page just like a Chrome-extension
save.

The plumbing:

1. `server/public/manifest.webmanifest` declares `share_target.action = /share`.
2. The browser sends `GET /share?url=…&title=…&text=…` once the user installs
   Memoria as a PWA.
3. `app.get('/share')` in `server/index.js` extracts the first http(s) URL it
   can find (preferring `url`, falling back to a regex over `text` / `title`),
   calls `bulkSaveUrls([url])`, and 303-redirects to `/?share=ok&u=…`.
4. The SPA shows a one-shot toast confirming the save.

## Android (Chrome / Edge / Brave)

1. Open `https://<your-memoria-host>/` in Chrome.
2. Menu → **Add to Home screen** (or **Install app**).
3. Once installed, **Memoria** appears in the share sheet of any app.
4. Sharing a page hands the URL to `/share`. Memoria fetches the HTML on the
   server, summarises, and adds it to the bookmark queue.

## iOS (Safari)

iOS Safari does **not** implement Web Share Target — there is no way for a PWA
to register in the iOS share sheet. The workaround is an iOS Shortcut:

1. Open the **Shortcuts** app.
2. Tap **+** → **New Shortcut**.
3. Add the **Get URLs from Input** action.
4. Add **URL** (`https://<your-memoria-host>/share?url=`).
5. Add **Combine Text** to concatenate the URL above with the URL from step 3
   (URL-encoded). The simplest way: use the **URL Encode** action between
   them, then **Get Contents of URL** with method `GET`.
6. Toggle **Show in Share Sheet** in shortcut settings.
7. Set **Share Sheet Types** to **URLs**.

A starter `.shortcut` JSON-equivalent (paste into the Shortcut text editor):

```text
Action 1: Get Contents of URL
  URL: https://YOUR-HOST/share?url=[URL Encoded Shortcut Input]
  Method: GET
  Headers: (none)
```

Once saved, sharing any URL from Safari → Memoria runs the shortcut, the
server saves the page, and the response (the redirect to `/?share=ok…`) is
discarded.

## Local-only / private deployments

If Memoria is reachable only on localhost, the PWA install path still works on
desktop (Chrome → Install app). Mobile share targets require a publicly
addressable HTTPS host — typical patterns:

- Tailscale + custom DNS for personal use.
- Reverse-proxy (Caddy / Cloudflare Tunnel) in front of `npm start`.

The `/share` handler trusts whoever can reach it, so do not expose the server
to the open internet without authentication. Multi-server mode (issue #34)
will add Cernere SSO in front of `/share` and the rest of the API.
