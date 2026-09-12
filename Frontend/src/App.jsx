import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import SignIn from "./pages/SignIn";
import Start from "./pages/Start";
import UserInput from "./pages/UserInput";
import Canvas from "./pages/Canvas";

function App() {
  return (
    <BrowserRouter>
      <Routes>

        <Route
          path="/signin"
          element={<SignIn />}
        />

        <Route
          path="/start"
          element={<Start />}
        />

        <Route
          path="/input"
          element={<UserInput />}
        />

        <Route
          path="/canvas"
          element={<Canvas />}
        />

        <Route
          path="*"
          element={<Navigate to="/signin" replace />}
        />

      </Routes>
    </BrowserRouter>
  );
}

export default App;
