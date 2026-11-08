use axum::{extract::Request, http::HeaderValue, middleware::Next, response::Response};
use std::time::Instant;
use tracing::Instrument;

pub fn init_logging() {
    // A fixed INFO ceiling avoids accidentally enabling dependency wire logs.
    tracing_subscriber::fmt()
        .json()
        .with_target(false)
        .with_max_level(tracing::Level::INFO)
        .init();
}

pub fn postgres_error_code(error: &sqlx::Error) -> String {
    error
        .as_database_error()
        .and_then(|error| error.code())
        .map(|code| code.into_owned())
        .unwrap_or_else(|| "transport".to_owned())
}

pub async fn observe_request(request: Request, next: Next) -> Response {
    // Never trust an incoming ID, or log URI/query/body/cookies/admin entry paths.
    let request_id = crate::id(16);
    let method = request.method().as_str().to_owned();
    let started = Instant::now();
    let mut response = next
        .run(request)
        .instrument(tracing::info_span!("http_request", requestId = %request_id))
        .await;
    response.headers_mut().insert(
        "x-request-id",
        HeaderValue::from_str(&request_id).expect("hex request ID is a valid header"),
    );
    let status = response.status().as_u16();
    tracing::info!(
        requestId = %request_id,
        method,
        status,
        elapsed_ms = started.elapsed().as_millis() as u64,
        category = if status >= 500 { "server_error" } else if status >= 400 { "client_error" } else { "success" },
        "http_response"
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::StatusCode, routing::get, Router};

    #[tokio::test]
    async fn request_ids_are_server_generated_and_bodies_are_unchanged() {
        let router = Router::new()
            .route("/ok", get(|| async { "unchanged body" }))
            .route(
                "/error",
                get(|| async { (StatusCode::FORBIDDEN, "denied") }),
            )
            .route(
                "/stream",
                get(|| async { Response::new(Body::from("data: one\n\ndata: two\n\n")) }),
            )
            .layer(axum::middleware::from_fn(observe_request));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::new();
        let mut ids = std::collections::HashSet::new();
        for (path, status, body) in [
            ("/ok", 200, "unchanged body"),
            ("/error", 403, "denied"),
            ("/stream", 200, "data: one\n\ndata: two\n\n"),
            ("/missing", 404, ""),
        ] {
            let response = client
                .get(format!("http://{address}{path}?not_logged=secret"))
                .header("x-request-id", "untrusted-client-value")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), status);
            let id = response.headers()["x-request-id"]
                .to_str()
                .unwrap()
                .to_owned();
            assert_eq!(id.len(), 32);
            assert!(id.bytes().all(|c| c.is_ascii_hexdigit()));
            assert!(ids.insert(id));
            assert_eq!(response.text().await.unwrap(), body);
        }
        server.abort();
    }

    #[test]
    fn postgres_error_details_do_not_escape_into_logs() {
        let error = sqlx::Error::Protocol("secret connection details".into());
        assert_eq!(postgres_error_code(&error), "transport");
    }
}
