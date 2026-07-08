package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
)

type Transaction struct {
	ID          int     `json:"id"`
	Description string  `json:"description"`
	Amount      float64 `json:"amount"`
	Type        string  `json:"type"` // "income" or "expense"
}

const dbFile = "database.json"

// Loads data from file on start
func loadDataFromFile() []Transaction {
	var txs []Transaction
	file, err := os.ReadFile(dbFile)
	if err != nil {
		return []Transaction{} // Return empty list if file doesn't exist yet
	}
	json.Unmarshal(file, &txs)
	return txs
}

// Saves data to file on every change
func saveDataToFile(txs []Transaction) {
	data, _ := json.MarshalIndent(txs, "", "  ")
	os.WriteFile(dbFile, data, 0644)
}

func main() {
	// Host frontend assets
	http.Handle("/", http.FileServer(http.Dir("./frontend")))
	
	// API route endpoint
	http.HandleFunc("/api/transactions", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

		if r.Method == "OPTIONS" {
			return
		}

		currentStore := loadDataFromFile()

		if r.Method == "GET" {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(currentStore)
			return
		}

		if r.Method == "POST" {
			var newTx Transaction
			if err := json.NewDecoder(r.Body).Decode(&newTx); err != nil {
				http.Error(w, "Bad Request", http.StatusBadRequest)
				return
			}
			newTx.ID = len(currentStore) + 1
			currentStore = append(currentStore, newTx)
			
			saveDataToFile(currentStore) // Permanent local drive write

			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(newTx)
			return
		}
	})

	fmt.Println("🚀 Premium Full-Stack Server active at http://localhost:8080")
	http.ListenAndServe(":8080", nil)
}
