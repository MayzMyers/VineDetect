import type { ClientSearchIndexResponse } from "./types";
import { buildSearchText } from "./searchText";

const items = [
  {
    id: "wine_001",
    title: "Fanagoria Avtorskoe Cabernet Saperavi 2021 dry red",
    producer: "Fanagoria",
    region: "Kuban",
    year: 2021,
    grapes: ["Cabernet", "Saperavi"],
    color: "red",
    sugar: "dry",
    aliases: ["fanagoria", "avtorskoe", "kaberne", "saperavi"],
  },
  {
    id: "wine_002",
    title: "Abrau-Durso Brut white sparkling",
    producer: "Abrau-Durso",
    region: "Krasnodar",
    grapes: ["Chardonnay", "Riesling"],
    color: "white",
    sugar: "brut",
    aliases: ["abrau durso", "abrau", "brut"],
  },
  {
    id: "wine_003",
    title: "Myskhako Cabernet Sauvignon 2020 dry red",
    producer: "Myskhako",
    region: "Kuban",
    year: 2020,
    grapes: ["Cabernet Sauvignon"],
    color: "red",
    sugar: "dry",
    aliases: ["myskhako", "cabernet"],
  },
  {
    id: "wine_004",
    title: "LETO Cabernet Franc Reserve 2020 dry red",
    producer: "LETO Winery",
    region: "Kuban",
    year: 2020,
    grapes: ["Cabernet Franc"],
    color: "red",
    sugar: "dry",
    aliases: ["leto", "reserve", "cabernet franc"],
  },
  {
    id: "wine_005",
    title: "Semigorye Riesling 2022 dry white",
    producer: "Semigorye",
    region: "Kuban",
    year: 2022,
    grapes: ["Riesling"],
    color: "white",
    sugar: "dry",
    aliases: ["semigorye", "riesling"],
  },
    {
    id: "wine_006",
    title: "Абрау-Дюрсо Брют розовое игристое",
    producer: "Абрау-Дюрсо",
    region: "Krasnodar",
    grapes: ["Chardonnay", "Riesling"],
    color: "pink",
    sugar: "brut",
    aliases: ["абрау-дюрсо", "абрау", "розовое", "дюрсо", "брют", "игристое", "шампанское", "1870"],
  },
];

export const mockCatalogIndex: ClientSearchIndexResponse = {
  version: "mock_002",
  updatedAt: "2026-07-09T00:00:00.000Z",
  itemCount: items.length,
  items: items.map((item) => ({
    ...item,
    category: `${item.color} ${item.sugar}`,
    normalizedText: [
      item.title,
      item.producer,
      item.region,
      item.year,
      item.grapes.join(" "),
      item.aliases.join(" "),
      item.color,
      item.sugar,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
    searchText: buildSearchText([
      item.title,
      item.producer,
      item.region,
      item.year,
      item.grapes.join(" "),
      item.aliases.join(" "),
      item.color,
      item.sugar,
      `${item.color} ${item.sugar}`,
    ]),
  })),
};
