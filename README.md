[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YuanBLQ/Qopy-Sync)

# Qopy Sync

This Worker stores encrypted Qopy favorites and portable settings in resources owned by your Cloudflare account. Qopy does not operate a shared synchronization service.

Cloudflare is currently the only provider. The repository keeps the Worker at its root so Cloudflare's deployment flow does not need monorepo or subdirectory support.

<!-- dash-content-start -->

## What it creates

- One Worker for the Qopy sync API.
- One D1 database for encrypted records and change history.
- One R2 bucket for encrypted favorite images.

The Worker never receives the synchronization password or the data-encryption key. Favorite content, portable settings, provider credentials, and images are encrypted by Qopy before upload.

<!-- dash-content-end -->

## Recommended deployment

1. In **Qopy > Settings > Sync > New Deployment**, select **Copy Token and Open Cloudflare**.
2. Sign in to Cloudflare and paste the copied value into `SETUP_TOKEN` when prompted.
3. After deployment, copy the Worker URL back into Qopy and choose a new sync password.

Cloudflare automatically provisions and binds D1 and R2 from `wrangler.jsonc`. The setup token is accepted only while the Worker is uninitialized.

## Manual deployment

1. Create a D1 database named `qopy-sync` and an R2 bucket named `qopy-sync-assets`.
2. Replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.jsonc` with the D1 database ID.
3. In **Qopy > Settings > Sync > New Deployment**, copy the generated setup token, then create a Worker secret named `SETUP_TOKEN` with that value:

   ```sh
   npx wrangler secret put SETUP_TOKEN
   ```

4. Install the development tools and deploy:

   ```sh
   npm install
   npm run deploy
   ```

5. Enter the resulting `workers.dev` URL in Qopy and choose a sync password. Qopy retains the one-time setup token locally until initial registration succeeds.

## Passwords and recovery

- **Change Password** replaces the authentication verifier and re-wraps the same data key. Existing cloud data is not rewritten.
- **Forgot Password or Rebuild Cloud Data** is available on an already connected Mac. It deletes the current D1 sync records and R2 objects, creates a new key, and uploads that Mac's local favorites and settings as the new cloud baseline.
- If no connected Mac remains, delete or redeploy the Cloudflare resources and set up sync again. Qopy cannot recover a forgotten password or decrypt the old cloud copy.

Cloudflare account backups or provider-level retention may outlive application-level deletion according to Cloudflare's own policies.

## Verify

```sh
npm test
```

## License

MIT
