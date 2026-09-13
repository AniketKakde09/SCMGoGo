const API_BASE_URL = "http://localhost:8000";

export async function processUserInput(userInput, sessionId = null) {
  const response = await fetch(
    `${API_BASE_URL}/api/process`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session_id: sessionId,
        message: userInput,
      }),
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      errorData.error?.message || errorData.message || `Backend request failed: ${response.status}`
    );
  }

  return await response.json();
}

export async function uploadDocument(file, sessionId = null) {
  const formData = new FormData();
  formData.append("file", file);

  const query = sessionId
    ? `?session_id=${encodeURIComponent(sessionId)}`
    : "";

  const response = await fetch(
    `${API_BASE_URL}/api/process/file${query}`,
    {
      method: "POST",
      body: formData,
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      errorData.error?.message || errorData.message || `File upload request failed: ${response.status}`
    );
  }

  return await response.json();
}
