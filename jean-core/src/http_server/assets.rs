use std::borrow::Cow;

#[derive(rust_embed::RustEmbed)]
#[folder = "../dist"]
pub struct FrontendAssets;

pub fn get(path: &str) -> Option<Cow<'static, [u8]>> {
    FrontendAssets::get(path).map(|file| file.data)
}
