# Miden Sudoku: website with Bread sign-in and cloud save

Files in this folder:

- `public/index.html`, `public/favicon.svg`: the game
- `src/worker.js`: the server (Bread sign-in check and cloud saves)
- `wrangler.jsonc`: Cloudflare settings
- `package.json`: the libraries Cloudflare installs (Miden SDK, noble)
- `scripts/copy-miden.mjs`: copies Miden's browser toolkit into `public/miden` during the build

## 1. Create the database

1. In Cloudflare, open **Storage & Databases → D1 SQL Database → Create**.
2. Name it `midensudoku-db` and create it.
3. Copy its **Database ID**.

The server creates its tables by itself the first time it runs.

## 2. Edit wrangler.jsonc

1. Replace `PASTE_DATABASE_ID_HERE` with the Database ID.
2. Check that `"name"` matches your Worker's name in **Workers & Pages**. If yours isn't called `midensudoku`, change it to match.

## 3. Replace the files on GitHub

1. In your `midensudoku` repository, delete the old `index.html`, `CNAME` and `favicon.svg`.
2. Choose **Add file → Upload files** and drag in everything from this folder, including the `src` and `public` folders, so the folders are kept.
3. Commit.

## 4. Check the build settings

In your Worker, open **Settings → Build**:

- Build command: `npm install && npm run build`
- Deploy command: `npx wrangler deploy`

Cloudflare rebuilds automatically after each commit. Watch the deployment under **Deployments**.

## 5. Test

1. Open https://midensudoku.xyz/api/health. It should show `"ok":true`, with `database`, `signatures` and `midenFiles` all `true`. If not, copy what it shows.
2. On a phone: open midensudoku.xyz, tap **Connect Bread**, and choose **Open in Bread**. In Bread, tap Connect Bread again and approve both requests.
3. On a computer: install the Bread extension for Chrome, open midensudoku.xyz, then tap **Connect Bread**.
4. Win a game on one device, then sign in on another. Your stats should appear there.
