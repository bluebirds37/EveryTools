//! 入口：`toolbox-server`
//! 配置全部来自环境变量（`docs/requirements.md` 附录 B），密钥禁止入库/入代码。

#[tokio::main]
async fn main() {
    if let Err(err) = toolbox_server::run_main().await {
        // root cause 链打印（不含密钥/用户内容）
        eprintln!("toolbox-server failed to start: {err:#}");
        std::process::exit(1);
    }
}
