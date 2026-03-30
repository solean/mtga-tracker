package main

import (
	"context"
	"database/sql"
	"log"
	"os"
	"path/filepath"

	"github.com/cschnabel/mtgdata/internal/appstate"
	"github.com/cschnabel/mtgdata/internal/api"
	"github.com/cschnabel/mtgdata/internal/db"
)

const desktopAPIAddress = "127.0.0.1:39123"

type App struct {
	ctx      context.Context
	cancel   context.CancelFunc
	database *sql.DB
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx

	supportBase, err := os.UserConfigDir()
	if err != nil {
		log.Printf("resolve user config dir: %v", err)
		return
	}

	supportDir := filepath.Join(supportBase, "mtgdata")
	if err := os.MkdirAll(supportDir, 0o755); err != nil {
		log.Printf("create support dir: %v", err)
		return
	}

	dbPath := filepath.Join(supportDir, "mtgdata.db")
	database, err := db.Open(dbPath)
	if err != nil {
		log.Printf("open desktop sqlite db: %v", err)
		return
	}
	if err := db.Init(context.Background(), database); err != nil {
		_ = database.Close()
		log.Printf("init desktop sqlite db: %v", err)
		return
	}

	store := db.NewStore(database)
	currentLogPath, prevLogPath, _ := appstate.DefaultMTGALogPaths()
	runtimeService, err := appstate.NewService(appstate.Options{
		Store:              store,
		DBPath:             dbPath,
		SupportDir:         supportDir,
		DefaultLogPath:     currentLogPath,
		DefaultPrevLogPath: prevLogPath,
	})
	if err != nil {
		_ = database.Close()
		log.Printf("init desktop runtime state: %v", err)
		return
	}

	server := api.NewServer(store, "", runtimeService)
	serverCtx, cancel := context.WithCancel(context.Background())

	a.database = database
	a.cancel = cancel

	go func() {
		if err := server.Run(serverCtx, desktopAPIAddress); err != nil {
			log.Printf("desktop API server exited: %v", err)
		}
	}()
}

func (a *App) shutdown() {
	if a.cancel != nil {
		a.cancel()
	}
	if a.database != nil {
		_ = a.database.Close()
		a.database = nil
	}
}
