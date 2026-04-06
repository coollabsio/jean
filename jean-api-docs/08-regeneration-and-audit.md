# Regeneration And Audit

Use these commands to keep docs current when Jean updates.

## 1. List all WS-dispatch commands

```bash
rg -n '^\s*"[a-zA-Z0-9_]+"\s*=>' src-tauri/src/http_server/dispatch.rs
```

## 2. Generate command + arg hint index

```bash
perl -ne '
  sub flush_cmd { if (defined $cmd) { print $cmd, "|", join(",", @args), "\n"; } %seen=(); @args=(); }
  if (/^\s*"([A-Za-z0-9_]+)"\s*=>/) { flush_cmd(); $cmd=$1; next; }
  next unless defined $cmd;
  if (/field\(&args,\s*"([^"]+)",\s*"([^"]+)"\)/) { $k="$1/$2"; if(!$seen{$k}++){ push @args,$k; } }
  if (/field_opt\(&args,\s*"([^"]+)",\s*"([^"]+)"\)/) { $k="?$1/$2"; if(!$seen{$k}++){ push @args,$k; } }
  if (/from_field\(&args,\s*"([^"]+)"\)/) { $k="$1"; if(!$seen{$k}++){ push @args,$k; } }
  if (/from_field_opt\(&args,\s*"([^"]+)"\)/) { $k="?$1"; if(!$seen{$k}++){ push @args,$k; } }
  END { flush_cmd(); }
' src-tauri/src/http_server/dispatch.rs | sort
```

Legend:
- `?field` = optional
- `camel/snake` = either accepted

## 3. Diff native command exposure vs WS dispatch

```bash
python3 -c "import re, pathlib; lib=pathlib.Path('src-tauri/src/lib.rs').read_text(); m=re.search(r'generate_handler!\\[(.*?)\\]\\)', lib, re.S); body=m.group(1) if m else ''; native=sorted(set(t.split('::')[-1] for t in re.findall(r'([a-zA-Z_][a-zA-Z0-9_:]*)\\s*,', body))); disp=pathlib.Path('src-tauri/src/http_server/dispatch.rs').read_text(); ws=sorted(set(re.findall(r'^\\s*\"([a-zA-Z0-9_]+)\"\\s*=>', disp, re.M))); print('NATIVE_NOT_IN_WS', len(set(native)-set(ws))); print('WS_NOT_IN_NATIVE', len(set(ws)-set(native)));"
```

## 4. Extract all WebSocket event names emitted via `emit_all`

```bash
python3 -c "import re, pathlib, glob; names=set();\
for p in glob.glob('src-tauri/src/**/*.rs', recursive=True):\
 t=pathlib.Path(p).read_text(errors='ignore');\
 [names.add(m.group(1)) for m in re.finditer(r'emit_all\\(\\s*\\\"([^\\\"]+)\\\"', t, re.S)];\
print('\n'.join(sorted(names)))"
```
