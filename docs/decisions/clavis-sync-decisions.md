# Clavis Sync: product decisions

Status: agreed with the product owner on 2026-11-26, branch `clavis-sync`. This reverses the v1 "Won't" items
"first-party accounts" and "cloud sync" in [requirements.md](../requirements.md). The privacy policy, store
disclosures and [architecture.md](../architecture.md) must be updated before release.

## Decisions

| ID   | Decision |
| ---- | -------- |
| S-01 | **Accounts are optional.** Signed out, Clavis keeps working exactly as today, local-only. Signing in adds sync and restore. |
| S-02 | **Google OAuth is the only sign-in method.** There are no passwords and no email sign-up. |
| S-03 | **Backend on Railway**, project `clavis`. It runs a Node/TypeScript API and Railway Postgres. The Google client secret and token-signing secret exist only as Railway variables. |
| S-04 | **Saved words** store the word or phrase, its meaning (the lookup result), the context, and the **source** (page URL and title, or PDF title and page). |
| S-05 | **Per-word AI chat.** Users can ask follow-up questions about a saved word, and the chat is kept with that word. **New messages can only be sent from the extension**, using the user's own Groq key. The web dashboard shows saved chats read-only. The server never calls an AI provider. |
| S-06 | **PDFs can be stored in the account.** Each file is limited to **15 MB**, and each account to **100 MB** of PDFs in total. Progress (last page and position) and highlights sync for every PDF, including ones that are not uploaded. |
| S-07 | **Both surfaces.** There are account screens in the extension and a web dashboard. |
| S-08 | **The PDF reader gets a layout and style redesign** as part of this work. |
| S-09 | **The Groq API key is never synced** or sent to the Clavis server. |
| S-10 | **Users can delete their account and all its data, and export their data.** |

## Infrastructure

- Railway project `clavis` was created on 2026-11-26 with a PostgreSQL service in the `production` environment.
- **S-11: the production API and dashboard origin is `https://clavis-api-production.up.railway.app`**, a Railway subdomain on service `clavis-api`, created 2026-11-26 with no source connected yet.
- Still to add: object storage for PDFs (a Railway Bucket, which is S3-compatible).

## Resolved

- **Stable extension ID.** Unpacked builds carry a development manifest `key` (extension ID `ebfpdncfkebjagolnbmfdhikaipiflbl`), and store ZIPs drop it (see `wxt.config.ts`).
- **Dashboard sign-in.** It uses a server-side OAuth redirect and a cookie session, separate from the extension's tokens. See [clavis-sync-design.md §2.5](../clavis-sync-design.md).
