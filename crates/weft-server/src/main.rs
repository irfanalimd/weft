//! Weft sync server binary. Configuration via `WEFT_ADDR`, `WEFT_DATA_DIR`, `WEFT_STATIC_DIR`,
//! `WEFT_LIMIT_*` and `WEFT_ALLOWED_ORIGINS` (see `weft_server::Limits`);
//! log filter via `RUST_LOG` (default `info`).

use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stdout()))
        .init();
    let config = match weft_server::Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("weft-server: {e}");
            std::process::exit(2);
        }
    };
    if let Err(e) = weft_server::run(config).await {
        tracing::error!(error = %e, "server failed");
        std::process::exit(1);
    }
}
