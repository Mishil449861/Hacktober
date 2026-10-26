"""
Plain-words explanations of Cloudinary delivery URLs, for the demo's "How Cloudinary handled the photo"
panel. Reads the transformation out of the actual URL the server used, so the page explains exactly what
was applied (nothing hard-coded). Free of Streamlit, so it can be tested.
"""
from __future__ import annotations

import re


def transformation(url: str) -> list[str]:
    """The transformation steps of a delivery URL: ".../image/upload/c_limit,w_1600/e_improve/v1/id" ->
    ["c_limit,w_1600", "e_improve"]. Empty for an untransformed original."""
    m = re.search(r"/upload/(.*?)/(?:v\d+/)", url.split("?")[0])
    if not m:
        return []
    return [s for s in m.group(1).split("/") if s and not re.fullmatch(r"v\d+", s)]


def _params(step: str) -> dict[str, str]:
    out = {}
    for part in step.split(","):
        key, _, value = part.partition("_")
        out[key] = value
    return out


def explain(step: str) -> str:
    """One transformation step in plain words."""
    p = _params(step)
    dims = [p[k] for k in ("w", "h") if k in p]
    size = f"{' × '.join(dims)} px" if dims else ""
    if p.get("c") == "limit":
        return (f"Shrinks the photo to fit within {size or 'the given size'}, never enlarging it. In our test, a full-size "
                "phone photo took the AI about 4 times longer to read than this copy (twice the input), with the same result")
    if p.get("c") == "fill":
        where = "around the most important part of the image (Cloudinary decides where: g_auto)" if p.get("g") == "auto" else "to fill the frame"
        return f"Crops to exactly {size} {where}"
    if "e" in p:
        effect, _, amount = p["e"].partition(":")
        return {
            "improve": "Automatically adjusts contrast and colour: a dim, grey photo comes out brighter",
            "sharpen": f"Sharpens edges{f' (strength {amount})' if amount else ''}",
        }.get(effect, f"Applies the {effect} effect")
    fmt, quality = p.get("f"), p.get("q")
    if fmt or quality:
        fmt_text = ("in the best format for each browser (f_auto)" if fmt == "auto"
                    else f"as {fmt.upper()}" if fmt else "")
        q_text = ("at an automatically chosen quality (q_auto)" if quality == "auto"
                  else f"at quality {quality}" if quality else "")
        return " ".join(["Delivered", fmt_text, q_text]).replace("  ", " ").strip()
    return f"Cloudinary transformation {step}"


def size_text(n: int | None) -> str:
    if not n:
        return ""
    return f"{n / 1024 / 1024:.1f} MB" if n >= 1024 * 1024 else f"{max(1, round(n / 1024))} KB"
