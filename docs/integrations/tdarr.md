# Tdarr Integration

Discarr can notify Tdarr after an encode completes, triggering a library scan so Tdarr picks up the new file for any further processing (remux, subtitle extraction, quality checks).

## Configuration

In `~/.config/media-postprocessor/api-keys.conf`:

```bash
TDARR_URL=http://your-tdarr-host:8265
```

## How it works

After the encode finishes and the arr notification fires, Discarr sends a scan request to Tdarr's API pointing at the output directory. Tdarr adds the new file to its processing queue.

!!! note "Optional integration"
    If `TDARR_URL` is not set, Discarr skips the Tdarr notification silently.

## When to use this

Useful if you run Tdarr for:

- Re-encoding to a specific codec/quality after Discarr's initial HEVC pass
- Subtitle extraction and burn-in
- Health checks on the output file before arr import
