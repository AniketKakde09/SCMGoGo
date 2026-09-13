import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import SignIn from "./pages/SignIn";
import Start from "./pages/Start";
import UserInput from "./pages/UserInput";
import Canvas from "./pages/Canvas";
import ForemanAnalysis from "./pages/ForemanAnalysis";

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
          path="/foreman-analysis"
          element={<ForemanAnalysis />}
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
