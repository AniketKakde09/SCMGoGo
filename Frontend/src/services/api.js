const API_BASE_URL = "http://localhost:8000";

export async function processUserInput(userInput) {
  const response = await fetch(
    `${API_BASE_URL}/process`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        input: userInput,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Backend request failed: ${response.status}`
    );
  }

  return await response.json();
}
