import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import SignIn from "./pages/SignIn";
import Start from "./pages/Start";
import UploadDataset from "./pages/UploadDataset";
import Canvas from "./pages/Canvas";
import ForecastReportRoute from "./pages/ForecastReportRoute";

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
          path="/upload"
          element={<UploadDataset />}
        />

        <Route
          path="/report"
          element={<ForecastReportRoute />}
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
