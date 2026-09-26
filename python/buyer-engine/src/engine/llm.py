import json
import os

MODEL = "gpt-4o-mini"
TIMEOUT_S = 15


def enabled() -> bool:
    return bool(os.environ.get("OPENAI_API_KEY"))


def _client():
    from openai import OpenAI

    return OpenAI(api_key=os.environ["OPENAI_API_KEY"], timeout=TIMEOUT_S)


def _complete(prompt: str, temperature: float = 0.4) -> str:
    response = _client().chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=temperature,
    )
    return (response.choices[0].message.content or "").strip()


def rewrite(instruction: str, text: str) -> tuple[str, str]:
    """Return (text, source). Falls back to the template text when the LLM is off or fails."""
    if not enabled() or not text:
        return text, "template"
    prompt = (
        "You are an M&A advisor at Mergero, a Nordic/DACH mid-market advisory firm.\n"
        f"{instruction}\n"
        "Keep every fact from the draft, invent nothing, and return only the rewritten text.\n\n"
        f"Draft:\n{text}"
    )
    try:
        result = _complete(prompt)
        return (result, "llm") if result else (text, "template")
    except Exception:
        return text, "template"


def classify(text: str, labels: list[str], timings: list[str] | None = None) -> dict | None:
    """Return {"category", "reason", "timing"} or None when the LLM is off, fails, or answers outside the labels.
    An invalid timing comes back as None so the caller can use its own rules."""
    if not enabled() or not text:
        return None
    timing_line = f"Allowed timings: {', '.join(timings)}.\n" if timings else ""
    prompt = (
        "Classify this reply from a company owner to an M&A advisor's outreach.\n"
        f"Allowed categories: {', '.join(labels)}.\n"
        f"{timing_line}"
        'Answer with JSON only: {"category": "...", "timing": "...", "reason": "one short sentence"}\n\n'
        f"Reply:\n{text}"
    )
    try:
        raw = _complete(prompt, temperature=0)
        data = json.loads(raw[raw.find("{"): raw.rfind("}") + 1])
    except Exception:
        return None
    if data.get("category") not in labels:
        return None
    timing = data.get("timing") if timings and data.get("timing") in timings else None
    return {"category": data["category"], "reason": str(data.get("reason") or ""), "timing": timing}
