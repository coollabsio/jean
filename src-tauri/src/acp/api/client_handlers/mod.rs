//! Client-side handlers for `on_receive_request` calls the agent makes
//! into us. Each capability we advertise (today: permission; soon: fs,
//! terminal) gets one file here.
//!
//! `application::supervisor` keeps the SDK closure shell (responder type isn't easy to
//! name across module boundaries) and delegates the body to a `handle`
//! function in the matching submodule.

pub mod fs;
pub mod permission;
