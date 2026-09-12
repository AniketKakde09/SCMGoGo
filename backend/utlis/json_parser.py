import json
import re

def parse_json(text: str):
    text = text.strip()
    
    # Remove markdown code fences.
    text = re.sub(
        r"^```json",
        "",
        text,
        flags=re.IGNORECASE,
    ).strip()

    text = re.sub(
        r"^```",
        "",
        text,
    ).strip()

    text = re.sub(
        r"```$",
        "",
        text,
    ).strip()

    # Extract first JSON object.
    match = re.search(
        r"\{.*\}",
        text,
        re.DOTALL,
    )

    if not match:
        raise ValueError("No JSON object found.")

    return json.loads(match.group())