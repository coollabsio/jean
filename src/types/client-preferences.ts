import type { AppPreferences } from './preferences'

export const CLIENT_PREFERENCE_KEYS = [
  'theme',
  'terminal',
  'terminal_renderer',
  'terminal_font',
  'terminal_font_size',
  'editor',
  'open_in',
  'ui_font_size',
  'chat_font_size',
  'ui_font',
  'chat_font',
  'font_weight',
  'keybindings',
  'syntax_theme_dark',
  'syntax_theme_light',
  'compact_chat_view_enabled',
  'file_edit_mode',
  'waiting_sound',
  'review_sound',
  'web_access_sounds_enabled',
  'desktop_notifications_enabled',
  'debug_mode_enabled',
  'has_seen_feature_tour',
  'has_seen_external_display_zoom_tip',
  'zoom_level',
  'mobile_zoom_level',
  'sync_zoom_levels',
  'confirm_session_close',
  'expand_tool_calls_by_default',
  'window_vibrancy',
  'finished_session_animation_enabled',
  'terminal_background',
  'terminal_background_custom',
] as const satisfies readonly (keyof AppPreferences)[]

export type ClientPreferenceKey = (typeof CLIENT_PREFERENCE_KEYS)[number]

export type ClientPreferences = Pick<AppPreferences, ClientPreferenceKey> & {
  schema_version: 1
}
