import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import SignIn from "./pages/SignIn";
import Start from "./pages/Start";
import UploadDataset from "./pages/UploadDataset";
import Canvas from "./pages/Canvas";
import PlanningPlayground from "./pages/PlanningPlayground";
import SADIntake from "./pages/SADIntake";
import ForecastReportRoute from "./pages/ForecastReportRoute";
import WorkspaceShell from "./components/WorkspaceShell";
import Estimation from "./pages/Estimation";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/signin" element={<SignIn />} />
        <Route element={<WorkspaceShell />}>
          <Route path="/start" element={<Start />} />
          <Route path="/upload" element={<UploadDataset />} />
          <Route path="/report" element={<ForecastReportRoute />} />
          <Route path="/canvas" element={<Canvas />} />
          <Route path="/playground" element={<PlanningPlayground />} />
          <Route path="/sad" element={<SADIntake />} />
          <Route path="/estimation" element={<Estimation />} />
        </Route>
        <Route path="*" element={<Navigate to="/start" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
