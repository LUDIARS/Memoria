# Downloadable local user apps

Memoria consumes the MmP package framework through its existing Git submodule. The host discovers bundled and installed apps locally, with private development folders taking precedence. Declarative metadata avoids importing executable code at startup; legacy folders remain compatible with an explicit discovery warning.

The user-apps view lists installed apps without automatically opening an iframe. Selecting an app activates it. The separate `アプリを取得する` panel fetches a configured catalog only when requested and shows package identity, version, description and requested capabilities. Installation requires explicit confirmation and the selected artifact digest. Catalog failure leaves installed apps available.

The optional `MEMORIA_PLUGIN_CATALOG_URL` uses HTTPS. `MEMORIA_PLUGIN_CATALOG_TOKEN`, when required by the eventual distribution service, is supplied through the existing secret environment and is never sent to the browser or persisted with package metadata. Missing optional catalog configuration disables acquisition only. A token without a URL or invalid configuration fails explicitly.

Package code is trusted local executable code, not sandboxed by capability labels. Acquisition and lifecycle mutations use the existing same-machine/configured-Access-host boundary, reject cross-site requests and require a matching Origin on mutations. Download URLs cannot be supplied by arbitrary browser requests; the configured catalog resolves approved identity/version/digest selections.

Installed versions live under `DATA_DIR/plugin-packages`. Settings and plugin database data remain separate. Package removal preserves data; saved versions can be selected through the API without network access. Local development overrides cannot be replaced through catalog operations.

On process shutdown the host disposes plugin resources before exiting. Jobs are non-overlapping and drained on reload. Individual integrations must honor cancellation and settle their work. Startup itself does not enable background integrations.

Acceptance: offline startup and user-app listing make no catalog request; selecting an installed app activates it; catalog failure does not remove installed apps; invalid identities, unconfirmed installs, missing/cross-origin mutations and remote peers are rejected. The MmP suite covers archive integrity and lifecycle behavior; Memoria tests cover host configuration and API authorization.

AWS publication and live catalog setup remain pending the user's access-policy choice and AWS reauthentication. This integration must not advertise a live distribution service before it exists.
