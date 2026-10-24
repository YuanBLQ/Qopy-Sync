# Qopy Sync

Self-hosted synchronization providers for Qopy. Each provider is designed to run in infrastructure owned by the user; Qopy does not operate a centralized synchronization service.

## Providers

| Provider | Status | Deployment |
| --- | --- | --- |
| [Cloudflare](providers/cloudflare) | Available | Worker + D1 + R2 |

## Security model

Qopy encrypts synchronized records and files on the Mac before upload. Providers store encrypted payloads, an authentication verifier, and a wrapped data-encryption key. They never receive the synchronization password or plaintext clipboard content.

Provider compatibility is versioned by the Qopy sync protocol. The current protocol version is `1`.

## License

MIT
