import type { Article, Feed, Library } from "./model";

const feeds: Feed[] = [
  {
    id: "design-milk",
    title: "Design Milk",
    url: "https://design-milk.com/feed/",
    siteUrl: "https://design-milk.com",
    category: "Design & inspiration",
    color: "#232725",
    icon: "dm",
  },
  {
    id: "dezeen",
    title: "Dezeen",
    url: "https://www.dezeen.com/feed/",
    siteUrl: "https://www.dezeen.com",
    category: "Design & inspiration",
    color: "#d8443a",
    icon: "d",
  },
  {
    id: "its-nice-that",
    title: "It’s Nice That",
    url: "https://www.itsnicethat.com/rss",
    siteUrl: "https://www.itsnicethat.com",
    category: "Design & inspiration",
    color: "#edb742",
    icon: "N",
  },
  {
    id: "the-verge",
    title: "The Verge",
    url: "https://www.theverge.com/rss/index.xml",
    siteUrl: "https://www.theverge.com",
    category: "Technology",
    color: "#6a43db",
    icon: "V",
  },
  {
    id: "css-tricks",
    title: "CSS-Tricks",
    url: "https://css-tricks.com/feed/",
    siteUrl: "https://css-tricks.com",
    category: "Technology",
    color: "#dc752b",
    icon: "*",
  },
  {
    id: "kinfolk",
    title: "Kinfolk",
    url: "https://www.kinfolk.com/feed/",
    siteUrl: "https://www.kinfolk.com",
    category: "Slow living",
    color: "#737950",
    icon: "K",
  },
  {
    id: "marginalian",
    title: "The Marginalian",
    url: "https://www.themarginalian.org/feed/",
    siteUrl: "https://www.themarginalian.org",
    category: "Slow living",
    color: "#c39144",
    icon: "m",
  },
];

const homeContent = `<p>There’s a particular feeling that comes with walking into a space that asks nothing of you. No clutter to make sense of. No noise to tune out. Just light, texture, and a little room to breathe.</p><p>More and more, we’re drawn to homes that feel this way. Not perfectly styled or impossibly minimal, but thoughtful. Lived-in. Quietly, unmistakably human.</p><h2>A little less, a little better</h2><p>A considered home isn’t about having less for the sake of it. It’s about surrounding yourself with things that earn their place — a chair that invites you to stay, a ceramic cup that fits just right in your hands, a plant that catches the afternoon sun.</p><blockquote>“The best rooms have something to say about the people who live in them.”</blockquote><p>Start with a corner. Move a chair toward the light. Put away the things you no longer notice. Leave a little space for the unexpected. Small shifts can change the way a whole room feels.</p><h2>Let the everyday be enough</h2><p>Natural materials offer a useful reminder: beauty doesn’t need to be polished to perfection. Wood deepens with time. Linen softens. The objects we use and love become a record of ordinary days.</p><p>Perhaps that’s the real art of making a home. Not chasing a finished picture, but creating a place where life can happen — slowly, comfortably, and on your own terms.</p>`;
const entries = [
  [
    "design-milk",
    "Finding calm in the spaces we call home",
    "Thoughtful interiors, natural materials, and the simple beauty of a little less.",
    "interior",
    8,
  ],
  [
    "dezeen",
    "A small cabin, a big connection to nature",
    "Tucked into a forest, this timber retreat makes the most of its surroundings.",
    "cabin",
    5,
  ],
  [
    "its-nice-that",
    "The wonderful imperfections of handmade type",
    "Meet the designers putting a little human touch back into our digital world.",
    "art",
    4,
  ],
  [
    "the-verge",
    "The next chapter of personal computing",
    "Smaller tools, bigger possibilities. A look at the ideas shaping what comes next.",
    "tech",
    6,
  ],
  [
    "kinfolk",
    "In good company: the art of gathering",
    "A table, a few friends, and no particular occasion. Sometimes that’s enough.",
    "table",
    7,
  ],
  [
    "css-tricks",
    "Little details that make the web feel better",
    "Thoughtful interactions that turn everyday interfaces into something special.",
    "",
    5,
  ],
  [
    "marginalian",
    "On the extraordinary gift of an ordinary day",
    "An invitation to pay attention to the small things we so often pass by.",
    "forest",
    9,
  ],
  [
    "design-milk",
    "Objects with a story to tell",
    "A new generation of makers finds beauty in the materials we leave behind.",
    "art",
    4,
  ],
  [
    "dezeen",
    "Built around the light",
    "An understated home that follows the rhythm of the day.",
    "interior",
    6,
  ],
  [
    "kinfolk",
    "The gentle practice of starting again",
    "Finding room for a different pace, one small ritual at a time.",
    "table",
    5,
  ],
  [
    "the-verge",
    "Why we’re falling in love with small cameras again",
    "A dedicated device can help us see the world a little differently.",
    "tech",
    4,
  ],
  [
    "its-nice-that",
    "Color outside the lines",
    "Fresh perspectives from an independent illustration studio.",
    "art",
    3,
  ],
  [
    "marginalian",
    "A field guide to everyday wonder",
    "Creativity begins with curiosity, and curiosity begins with looking.",
    "forest",
    8,
  ],
  [
    "design-milk",
    "Designed to stand the test of time",
    "Honest materials and familiar forms that feel just as right today.",
    "interior",
    5,
  ],
] as const;

export function createSeed(): Library {
  const now = Date.now();
  const articles: Article[] = entries.map(
    ([feedId, title, excerpt, image, readingTime], index) => ({
      id: `sample-${index}`,
      feedId,
      title,
      excerpt,
      image: image ? `./images/${image}.jpg` : undefined,
      url: feeds.find((feed) => feed.id === feedId)!.siteUrl,
      author: "Folio editorial",
      publishedAt: new Date(
        now - (index < 7 ? index * 3600000 + 1800000 : (index + 12) * 3600000),
      ).toISOString(),
      readingTime,
      content:
        index === 0
          ? homeContent
          : `<p>${excerpt}</p><p>In a world that seems to move a little faster every day, it’s worth making space for the ideas that invite us to pause. This is one of those ideas: a different perspective on the familiar, and a reminder that there is always something new to notice.</p><h2>A fresh perspective</h2><p>The most interesting discoveries often begin with a simple question. What if we approached the everyday with a little more curiosity? What if we took the time to understand how things were made, why they work, and how they make us feel?</p><p>There’s no single answer, but that’s part of the pleasure. Follow a thread, explore a new idea, and see where it takes you.</p><blockquote>Good things happen when we make room for curiosity.</blockquote><p>This original sample essay is here to help you explore Folio. Refresh your feeds to discover the latest stories from your favorite publications.</p>`,
      read: index === 0 || [6, 9, 11, 13].includes(index),
      starred: [4, 8, 12].includes(index),
      sample: true,
    }),
  );
  return {
    version: 1,
    feeds,
    articles,
    settings: { interval: 30, fontSize: 18, theme: "light" },
  };
}
