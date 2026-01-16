import { render, screen } from "@testing-library/react";
import App from "./App";

test("renders chat header title", () => {
  render(<App />);
  expect(screen.getByText(/Chatbot/i)).toBeInTheDocument();
});
