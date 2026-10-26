//! Minimal native client for poking a running server by hand.
//!
//! ```sh
//! cargo run -p weft-server --example ws_client -- ws://127.0.0.1:7878/ws/my-doc "hello " "world"
//! ```
//! Connects, completes the handshake, appends each argument (one edit per argument, typed
//! while live), keeps listening for `WAIT_MS` (default 1000) and prints the final text.
//! For a private note (`/ws/n/<id>`) set `COOKIE='weft_session=<token>'`; `ORIGIN` adds an
//! `Origin` header.

use std::time::Duration;

use futures::{SinkExt, StreamExt};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::{Message as WsMessage, client::IntoClientRequest, http};
use weft_core::Doc;
use weft_sync::{ClientSession, Message};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut args = std::env::args().skip(1);
    let url = args.next().expect("usage: ws_client <ws-url> [text...]");
    let edits: Vec<String> = args.collect();
    let wait_ms: u64 = std::env::var("WAIT_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1000);
    let doc_id = url.rsplit('/').next().unwrap().to_string();
    let client_id = rand::random::<u64>() | 1;
    let mut session = ClientSession::new(doc_id, Doc::new(client_id));

    let mut req = url.as_str().into_client_request().expect("bad url");
    for (var, name) in [
        ("COOKIE", http::header::COOKIE),
        ("ORIGIN", http::header::ORIGIN),
    ] {
        if let Ok(v) = std::env::var(var) {
            req.headers_mut()
                .insert(name, v.parse().expect("header value"));
        }
    }
    let mut ws = match connect_async(req).await {
        Ok((ws, _)) => ws,
        Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => {
            let body = resp.body().as_deref().map(String::from_utf8_lossy);
            eprintln!("connect refused: HTTP {} {:?}", resp.status(), body);
            std::process::exit(1);
        }
        Err(e) => panic!("connect: {e}"),
    };
    for m in session.on_connected() {
        ws.send(WsMessage::binary(m.encode())).await.unwrap();
    }
    let mut pending = edits.into_iter();
    let mut announced = false;
    let deadline = tokio::time::sleep(Duration::from_millis(wait_ms));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            frame = ws.next() => {
                let Some(Ok(frame)) = frame else { break };
                let WsMessage::Binary(bytes) = frame else { continue };
                let msg = Message::decode(&bytes).expect("decode");
                if let Message::Error { code, message } = &msg {
                    eprintln!("server error {code}: {message}");
                }
                let out = session.on_message(msg).expect("on_message");
                for (id, p) in &out.awareness {
                    let p = p.as_ref().map(|b| String::from_utf8_lossy(b).into_owned());
                    println!("awareness {id:x}: {p:?}");
                }
                for m in out.send {
                    ws.send(WsMessage::binary(m.encode())).await.unwrap();
                }
                if session.is_live() {
                    // Type the edits one by one once live.
                    for text in pending.by_ref() {
                        let pos = session.doc().len_utf16();
                        for m in session.insert(pos, &text) {
                            ws.send(WsMessage::binary(m.encode())).await.unwrap();
                        }
                    }
                    if !announced {
                        announced = true;
                        if std::env::var_os("GARBAGE").is_some() {
                            ws.send(WsMessage::binary(vec![0xff, 0xff, 0xff])).await.unwrap();
                        }
                        let aw = format!("{{\"name\":\"cli-{:x}\"}}", client_id & 0xffff);
                        for m in session.set_awareness(aw.into_bytes()) {
                            ws.send(WsMessage::binary(m.encode())).await.unwrap();
                        }
                    }
                }
            }
            _ = &mut deadline => break,
        }
    }
    println!(
        "synced={} unsynced={} text={:?}",
        session.is_synced(),
        session.unsynced_op_count(),
        session.doc().text()
    );
    let _ = ws.close(None).await;
}
