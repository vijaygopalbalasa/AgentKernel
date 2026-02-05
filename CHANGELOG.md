# Changelog

## 0.1.5 (2026-02-06)

### Security Fix
- **Shell → file policy cross-check**: Commands like `cat ~/.ssh/id_rsa`, `head ~/.aws/credentials`, `cp ~/.ssh/id_rsa /tmp/stolen` are now **blocked** even when the base command (cat, head, cp) is on the shell allow list. File-reading/writing shell commands have their path arguments checked against file policies.

### Fixed
- **`workspace:*` dependency protocol**: Replaced with real version ranges so `npm install -g` works
- **`policy test --command`**: `agentkernel policy test --command "git status"` now correctly returns ALLOWED (was returning BLOCKED because the command wasn't being split into base command + args)
- 5 new tests for shell→file cross-check security (185 total)

## 0.1.3 (2026-02-06)

### Fixed
- **Standalone mode**: `agentkernel start` now works without a gateway — runs as a standalone HTTP + WebSocket security evaluation service
- **Multi-format support**: Accepts OpenClaw, MCP/JSON-RPC, and Simple `{tool, args}` message formats
- **Interactive approval**: When running in a TTY, approval requests prompt the user instead of auto-denying
- **Duplicate logging**: Fixed console audit logs printing twice
- **Live status**: `agentkernel status` now connects to the running proxy's HTTP API for real-time stats

### Added
- HTTP API endpoints: `GET /health`, `POST /evaluate`, `GET /stats`, `GET /audit`
- WebSocket evaluate mode — send tool calls, receive allow/block decisions
- `AGENTKERNEL_MODE` environment variable to force evaluate or proxy mode
- Message normalizer module with 27 tests
- 12 new proxy tests (180 total across the CLI package)

### Changed
- Default mode is now **standalone evaluate** (no `--gateway` flag needed)
- `--gateway <url>` flag enables proxy mode (was previously the only mode)
- Updated all documentation to reflect standalone-first workflow

## 0.1.2 (2026-02-05)

### Fixed
- Bind to `0.0.0.0` by default instead of localhost (allow external connections)
- Replace `workspace:*` protocol references with real version ranges for npm compatibility

## 0.1.0 (2026-02-05)

### Added
- Initial public release
- Policy engine with file, network, and shell rules
- Capability-based permissions with HMAC-signed tokens
- Process sandbox with V8 isolates
- Full audit logging to PostgreSQL
- CLI with `init`, `start`, `allow`, `block`, `unblock`, `policy show/test`, `status`, `audit` commands
- LangChain adapter for tool interception
- Default policy blocking 341+ malicious patterns (AMOS Stealer, reverse shells, data exfiltration, SSRF)
- 1,175+ tests across all packages
