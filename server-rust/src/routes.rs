use crate::*;

pub fn router(app: App) -> Router {
    Router::new()
        .fallback(dispatch)
        .with_state(app)
        .layer(axum::middleware::from_fn(
            crate::middleware::observe_request,
        ))
}

async fn dispatch(
    State(a): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request<Body>,
) -> Result<Response> {
    let method = req.method().as_str().to_owned();
    let url = url::Url::parse(&format!("http://localhost{}", req.uri()))
        .map_err(|_| fail("请求路径无效"))?;
    let path = url
        .path()
        .strip_prefix("/jianlai/")
        .map(|s| format!("/{s}"))
        .unwrap_or_else(|| url.path().to_owned());
    let h = req.headers().clone();
    handlers::api::handle(a, path, method, url, h, req, peer).await
}
