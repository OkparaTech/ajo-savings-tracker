# 📊 Full-Stack Capital Tracker (Go + JavaScript)

A premium, interactive finance dashboard built with a native JavaScript frontend and a high-performance backend server written in Go (Golang). It scans user inputs to display dynamic contextual emojis and writes logs permanently to a local file storage database.

---

## 🚀 Key Features

- ⚡ **Go-Powered Backend:** Handles high-speed HTTP network API routing cleanly on port `8080`.
- 💾 **File-Storage Persistence:** Saves every transaction into a structured local `database.json` file on the hard drive. Data survives server reboots!
- 🧠 **Context-Aware Emojis:** Frontend logic auto-scans text arrays to automatically apply visual emojis (e.g., 💰 for Salary, 🍕 for Food).
- 🚨 **Reactive UI Alerts:** The balance interface card dynamically mutates into an animated warning crimson shade if you slip into a negative net overspending state.

---

## 🛠️ Architecture Breakdown

- **`frontend/`**: Contains the client-side user experience environment (`index.html`, `style.css`, `script.js`). Uses the standard browser `fetch()` API to communicate over the local network.
- **`main.go`**: The server controller. Manages data serialization (JSON parsing), Cross-Origin Resource Sharing (CORS) configurations, and file read/write input loops.

---

## ⚙️ How to Run Locally

1. Ensure **Go** is installed on your machine.
2. Clone this repository and open your terminal inside the folder directory.
3. Boot up the backend server:
   ```bash
   go run main.go
   ```
4. Launch your browser and navigate to: `http://localhost:8080`
