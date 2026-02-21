export type CardPreview = {
  name: string;
  imageUrl: string;
  scryfallUrl?: string;
};

type ScryfallImageURIs = {
  png?: string;
  large?: string;
  normal?: string;
  small?: string;
};

type ScryfallCardFace = {
  image_uris?: ScryfallImageURIs | null;
};

type ScryfallCard = {
  name?: string;
  scryfall_uri?: string;
  image_uris?: ScryfallImageURIs | null;
  card_faces?: ScryfallCardFace[] | null;
};

const SCRYFALL_BASE_URL = "https://api.scryfall.com";

function pickImageURL(card: ScryfallCard): string {
  const root = card.image_uris ?? undefined;
  if (root) {
    const rootURL = root.normal ?? root.large ?? root.small ?? root.png;
    if (rootURL) {
      return rootURL;
    }
  }

  for (const face of card.card_faces ?? []) {
    const faceImage = face.image_uris ?? undefined;
    if (!faceImage) {
      continue;
    }
    const faceURL = faceImage.normal ?? faceImage.large ?? faceImage.small ?? faceImage.png;
    if (faceURL) {
      return faceURL;
    }
  }

  return "";
}

async function fetchScryfallCard(path: string): Promise<ScryfallCard | null> {
  const response = await fetch(`${SCRYFALL_BASE_URL}${path}`, {
    headers: {
      Accept: "application/json",
    },
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Scryfall lookup failed (${response.status})`);
  }
  return (await response.json()) as ScryfallCard;
}

async function fetchByName(name: string): Promise<ScryfallCard | null> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return null;
  }
  const encoded = encodeURIComponent(trimmedName);
  const exact = await fetchScryfallCard(`/cards/named?exact=${encoded}`);
  if (exact) {
    return exact;
  }
  return fetchScryfallCard(`/cards/named?fuzzy=${encoded}`);
}

export async function fetchCardPreview(cardID: number, cardName?: string): Promise<CardPreview | null> {
  if (!Number.isFinite(cardID) || cardID <= 0) {
    return null;
  }

  let card: ScryfallCard | null = null;
  try {
    card = await fetchScryfallCard(`/cards/arena/${cardID}`);
  } catch {
    card = null;
  }

  if (!card && cardName) {
    try {
      card = await fetchByName(cardName);
    } catch {
      card = null;
    }
  }

  if (!card) {
    return null;
  }

  const imageURL = pickImageURL(card);
  if (!imageURL) {
    return null;
  }

  return {
    name: card.name?.trim() || cardName?.trim() || `Card ${cardID}`,
    imageUrl: imageURL,
    scryfallUrl: card.scryfall_uri,
  };
}
