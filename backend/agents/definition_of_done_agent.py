"""Generate a shared Definition of Done when the input does not provide one."""

from prompts.definition_of_done_prompt import DEFINITION_OF_DONE_PROMPT
from services.llm import call_llm
from utlis.json_parser import parse_json


def run(state: dict) -> dict:
    try:
        response = call_llm(
            f"{DEFINITION_OF_DONE_PROMPT}\n\nPI input:\n{state.get('parsed_text', '')}",
            json_mode=True,
            max_output_tokens=700,
        )
        criteria = parse_json(response).get("definition_of_done", [])
        state["definition_of_done"] = [
            criterion.strip()
            for criterion in criteria
            if isinstance(criterion, str) and criterion.strip()
        ][:5]
    except Exception as error:
        print(f"Definition of Done generation failed: {error}")
        state["definition_of_done"] = []

    state["has_definition_of_done"] = bool(state["definition_of_done"])
    return state
