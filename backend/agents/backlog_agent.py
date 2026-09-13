import json
from utlis.json_parser import parse_json
from services.llm import call_llm
from prompts.backlog_prompt import BACKLOG_AGENT_PROMPT

def run(state: dict) -> dict:
    print("\n============= Backlog Stage =============")
    
    prompt = f"""
    {BACKLOG_AGENT_PROMPT}
    Goal:

    {state.get('goal', '')}
    Scope:

    {state.get('scope', '')}
    Requirements:

    {state.get('requirements', [])}
    Non Functional Requirements:

    {state.get('non_functional_requirements', [])}
    Constraints:

    {state.get('constraints', [])}
    Dependencies:

    {state.get('dependencies', [])}
    Personas:

    {state.get('personas', [])}
    Assumptions:

    {state.get('assumptions', [])}
    """
    
    try:
        response = call_llm(
            prompt,
            json_mode=True
        )

        try:
            result = parse_json(response)
        except Exception as parse_error:
            print(
                "Initial backlog JSON parsing failed: "
                f"{parse_error}"
            )

            repair_prompt = f"""
            Convert the following model response into valid JSON.
            Rules:

            Return ONLY valid JSON.
            Preserve the backlog content exactly where possible.
            The top-level object must contain an epics array.
            Do not add commentary.
            Do not add Markdown fences.
            Do not add new requirements.
            Do not add new integrations.
            Do not add new technologies.
            Do not add new business rules.
            Model response:
            {response}
            """
            
            repaired_response = call_llm(repair_prompt)
            result = parse_json(repaired_response)

        epics = result.get("epics", [])

        if not isinstance(epics, list):
            epics = []

        state["epics"] = epics

        print("\n========== GENERATED BACKLOG ==========")
        print(json.dumps(state["epics"], indent=4))
        print("=======================================\n")

    except Exception as error:
        print(f"Backlog stage failed: {error}")
        state["epics"] = []
        state["error"] = (
            "I couldn't generate a valid backlog "
            "from that requirement."
        )

    return state