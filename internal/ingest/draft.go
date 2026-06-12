package ingest

import (
	"strconv"
	"strings"
)

type playerDraftPickRequest struct {
	DraftID string  `json:"DraftId"`
	GrpIDs  []int64 `json:"GrpIds"`
	Pack    int64   `json:"Pack"`
	Pick    int64   `json:"Pick"`
}

type botDraftPickRequest struct {
	EventName string `json:"EventName"`
	PickInfo  struct {
		CardIDs    []string `json:"CardIds"`
		PackNumber int64    `json:"PackNumber"`
		PickNumber int64    `json:"PickNumber"`
	} `json:"PickInfo"`
}

type draftCompleteRequest struct {
	EventName  string `json:"EventName"`
	IsBotDraft bool   `json:"IsBotDraft"`
}

func parseStringIDsToInt64(in []string) []int64 {
	out := make([]int64, 0, len(in))
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		v, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			continue
		}
		out = append(out, v)
	}
	return out
}
