# Disc Formats

Discarr supports the following input formats:

## VIDEO_TS (DVD)

Standard DVD file structure. Discarr reads IFO files to extract title, chapter, and duration information.

```
/media/disc/
└── VIDEO_TS/
    ├── VIDEO_TS.IFO
    ├── VTS_01_0.IFO
    ├── VTS_01_0.VOB
    ├── VTS_01_1.VOB
    └── ...
```

**Multi-episode discs:** Discarr reads chapter boundaries from IFO data to identify individual episodes within a single title. You can split a title into multiple episodes during the mapping step.

## BDMV (Blu-ray)

Standard Blu-ray structure. Discarr reads CLPI (clip info) and MPLS (playlist) files for title enumeration.

```
/media/disc/
└── BDMV/
    ├── BACKUP/
    ├── CERTIFICATE/
    ├── CLIPINF/
    ├── MOVIEOBJ.BDM
    ├── STREAM/
    └── ...
```

## ISO

Disc image files. Discarr mounts the ISO in memory and scans the inner structure (VIDEO_TS or BDMV).

```
/media/disc.iso
```

!!! note "libdvdcss for encrypted DVDs"
    CSS-encrypted DVD ISOs require libdvdcss to be installed. The native installer handles this. The Docker image includes libdvdcss.

## Multi-disc sets

Discarr handles multi-disc sets by scanning each disc directory separately. Map each disc in sequence — the episode counter picks up where the previous disc left off.

## Scan path tips

- Pass the directory containing `VIDEO_TS` or `BDMV`, not the inner directory itself
- For ISOs, pass the full `.iso` file path
- Symlinks are followed
