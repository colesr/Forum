// cloud-functions.js — client-side ports of every Cloud Function in
// functions/index.js. Each entry on `dispatch` is invoked by the
// firebase-functions shim's httpsCallable() with (data, ctx) where ctx.auth.uid
// matches the current logged-in user. The 21 AI-calling functions hit the
// Gemini REST API directly via callGemini(). Document triggers are registered
// at module load via registerDocumentTrigger().

import {
  collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, serverTimestamp, arrayUnion, arrayRemove,
  deleteField, Timestamp, registerDocumentTrigger, db,
} from './firebase-firestore.js';
import { callGemini, parseJsonLoose } from './gemini.js';

// =============================================================================
// CONSTANTS (mirrored from functions/index.js)
// =============================================================================

const BOT_USER_ID = '__journeyhub_platform_guide__';
const BOT_DISPLAY_NAME = 'JourneyHub Guide';
const SPARK_BOT_ID = '__journeyhub_spark_bot__';
const SPARK_BOT_NAME = 'Spark Bot';

const BADGE_DEFINITIONS = {
  first_thread:        { id: 'first_thread',        name: 'First Spark',         description: 'Posted your first thread',          icon: '✨', tier: 1 },
  first_comment:       { id: 'first_comment',       name: 'Voice Found',         description: 'Left your first comment',           icon: '💬', tier: 1 },
  helpful_x5:          { id: 'helpful_x5',          name: 'Helpful',             description: 'Earned 5 helpful comment likes',    icon: '🤝', tier: 2 },
  helpful_x25:         { id: 'helpful_x25',         name: 'Pillar',              description: 'Earned 25 helpful comment likes',   icon: '🏛️', tier: 3 },
  thread_loved:        { id: 'thread_loved',        name: 'Loved Thread',        description: 'A thread of yours got 10+ likes',   icon: '💖', tier: 2 },
  engaged_commentator: { id: 'engaged_commentator', name: 'Engaged Commentator', description: 'Left 20+ comments',                 icon: '🎙️', tier: 2 },
  community_builder:   { id: 'community_builder',   name: 'Community Builder',   description: 'Created a community',               icon: '🏗️', tier: 3 },
  learning_achiever:   { id: 'learning_achiever',   name: 'Learning Achiever',   description: 'Completed a growth milestone',      icon: '🎯', tier: 2 },
  mentor:              { id: 'mentor',              name: 'Trusted Mentor',      description: 'Received 10+ trust vouches',        icon: '🌟', tier: 4 },
};

const RSS_FEEDS = [
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml',          name: 'BBC' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml',            name: 'Al Jazeera' },
  { url: 'https://feeds.npr.org/1004/rss.xml',                   name: 'NPR' },
  { url: 'https://www.theguardian.com/world/rss',                name: 'Guardian' },
  { url: 'https://abcnews.go.com/abcnews/internationalheadlines',name: 'ABC' },
  { url: 'https://www.cbc.ca/cmlink/rss-world',                  name: 'CBC' },
];

// Minimal growth resource catalog so searchGrowthResources can return something
// stable. The original cloud function shipped a 21-resource catalog; this is a
// representative sample. The browser-side rankLocalResources() in index.html
// uses its own catalog separately.
const GROWTH_RESOURCE_CATALOG = [
  { id: 'ai_coach_clarity', title: 'Clarity Coach',         category: 'ai_coach',     description: 'AI conversation that helps you name vague feelings and pick a single next action.', tags: ['clarity','focus','overwhelm'], actionLabel: 'Open AI coach', route: 'resources' },
  { id: 'ai_coach_career',  title: 'Career Coach',          category: 'ai_coach',     description: 'Targeted reflection prompts about work, role design, and growth bets.',           tags: ['career','work','growth'],     actionLabel: 'Open AI coach', route: 'resources' },
  { id: 'self_audit_values',title: 'Values Audit',          category: 'self_disc',    description: 'A 12-question audit that surfaces your top 5 working values.',                    tags: ['values','identity'],          actionLabel: 'Start audit',  route: 'resources' },
  { id: 'community_makers', title: 'Makers Community',      category: 'community',    description: 'A community of independent builders shipping projects week by week.',             tags: ['community','builders'],       actionLabel: 'Join',         route: 'communities' },
  { id: 'course_systems',   title: 'Personal Systems Course',category: 'course',      description: 'A short course on building habit stacks and weekly review rituals.',              tags: ['habits','systems'],           actionLabel: 'Open course',  route: 'resources' },
  { id: 'book_deepwork',    title: 'Deep Work',             category: 'book',         description: 'Cal Newport on focused work and crafting attention.',                             tags: ['focus','deep work'],          actionLabel: 'Open',         route: 'resources' },
  { id: 'podcast_huberman', title: 'Tools for the mind',    category: 'podcast',      description: 'Science-backed conversations about productivity, sleep, and motivation.',         tags: ['health','focus'],             actionLabel: 'Listen',       route: 'resources' },
];

// =============================================================================
// HELPERS
// =============================================================================

function requireAuth(ctx) {
  if (!ctx || !ctx.auth || !ctx.auth.uid) {
    const e = new Error('unauthenticated'); e.code = 'unauthenticated'; throw e;
  }
  return ctx.auth.uid;
}

async function getUserProfile(uid) {
  if (!uid) return null;
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? snap.data() : null;
}

async function addNotification(userId, type, text, linkId = null) {
  if (!userId) return;
  await addDoc(collection(db, 'notifications'), {
    userId, type, text, linkId, read: false, timestamp: serverTimestamp(),
  });
}

function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return {};
  const out = {};
  let count = 0;
  for (const k of Object.keys(metadata)) {
    if (count >= 12) break;
    const key = String(k).slice(0, 40);
    const v = metadata[k];
    if (typeof v === 'string') out[key] = v.slice(0, 40);
    else if (typeof v === 'number' || typeof v === 'boolean') out[key] = v;
    else continue;
    count++;
  }
  return out;
}

function normalizeMessageTimestamp(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts._seconds) return ts._seconds * 1000;
  if (ts.seconds) return ts.seconds * 1000;
  return 0;
}

async function awardBadge(userId, badgeId) {
  const def = BADGE_DEFINITIONS[badgeId];
  if (!def) return;
  const ref = doc(db, 'userBadges', userId, 'badges', badgeId);
  const existing = await getDoc(ref);
  if (existing.exists()) return;
  await setDoc(ref, { ...def, awardedAt: serverTimestamp() });
}

async function checkAndAwardBadges(userId) {
  if (!userId) return;
  // Threads by user
  const threadSnap = await getDocs(query(collection(db, 'threads'), where('authorId', '==', userId)));
  if (threadSnap.size > 0) await awardBadge(userId, 'first_thread');
  let totalThreadLikes = 0;
  let lovedThread = false;
  threadSnap.forEach((t) => {
    const likes = t.data().likes || 0;
    totalThreadLikes += likes;
    if (likes >= 10) lovedThread = true;
  });
  if (lovedThread) await awardBadge(userId, 'thread_loved');

  // Comments by user
  const commentSnap = await getDocs(query(collection(db, 'comments'), where('authorId', '==', userId)));
  if (commentSnap.size > 0) await awardBadge(userId, 'first_comment');
  if (commentSnap.size >= 20) await awardBadge(userId, 'engaged_commentator');
  let totalCommentLikes = 0;
  commentSnap.forEach((c) => { totalCommentLikes += c.data().likes || 0; });
  if (totalCommentLikes >= 5)  await awardBadge(userId, 'helpful_x5');
  if (totalCommentLikes >= 25) await awardBadge(userId, 'helpful_x25');

  // Community builder
  const commSnap = await getDocs(query(collection(db, 'communities'), where('createdBy', '==', userId)));
  if (commSnap.size > 0) await awardBadge(userId, 'community_builder');

  // Learning achiever — checks user.completedMilestones
  const profile = await getUserProfile(userId);
  if (profile && (profile.completedMilestones || 0) > 0) await awardBadge(userId, 'learning_achiever');

  // Trusted mentor — 10+ active vouches received
  const vouchSnap = await getDocs(query(
    collection(db, 'trustVouches'),
    where('toUserId', '==', userId),
    where('status', '==', 'active')
  ));
  if (vouchSnap.size >= 10) await awardBadge(userId, 'mentor');
}

async function getUserBadgesInternal(userId) {
  if (!userId) return [];
  const snap = await getDocs(collection(db, 'userBadges', userId, 'badges'));
  const out = [];
  snap.forEach((d) => {
    const data = d.data();
    out.push({
      id: d.id,
      name: data.name,
      icon: data.icon,
      description: data.description,
      tier: data.tier,
      awardedAt: data.awardedAt && data.awardedAt.toMillis ? data.awardedAt.toMillis() : Date.now(),
    });
  });
  out.sort((a, b) => (b.awardedAt || 0) - (a.awardedAt || 0));
  return out;
}

async function deleteDocRefsInChunks(refs, _chunk = 400) {
  for (const r of refs) {
    try { await deleteDoc(r); } catch {}
  }
}

// Strip HTML for analyzeWebsiteMood
function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse the 4-line MOOD/EMOJI/SUMMARY/UNDERCURRENT format used by mood prompts.
function parseMoodResponse(text) {
  const grab = (label) => {
    const m = new RegExp(label + ':\\s*(.+)', 'i').exec(text || '');
    return m ? m[1].trim().replace(/^\[|\]$/g, '').trim() : '';
  };
  return {
    word: grab('MOOD') || 'Reflective',
    emoji: grab('EMOJI') || '🌀',
    summary: grab('SUMMARY') || (text || '').trim(),
    undercurrent: grab('UNDERCURRENT') || '',
  };
}

// =============================================================================
// AI HELPERS (platform guide bot, spark bot)
// =============================================================================

async function buildPlatformGuideReply(userProfile, messageText, history) {
  const trimmedHistory = (history || []).slice(-8).map((h) => `- ${h.author || 'user'}: ${h.content || ''}`).join('\n');
  const profileLine = userProfile
    ? `User profile — username: ${userProfile.username || 'member'}, headline: ${userProfile.headline || ''}, currently focused on: ${userProfile.currentFocus || ''}`
    : 'User profile unknown.';
  const prompt = `You are JourneyHub Guide, a warm and concise platform-onboarding bot inside a community platform called JourneyHub.
You help members navigate features (profiles, communities, the following feed, threads/comments, messages, growth paths, AI insight tools, mood analyzer).
Style: 2-4 short sentences, end with a small follow-up question. Avoid generic motivational fluff.

${profileLine}

Recent conversation:
${trimmedHistory}

User just said: ${messageText}

Reply as JourneyHub Guide.`;
  try {
    return (await callGemini(prompt)).trim()
      || "I'm here — what can I help you find on JourneyHub?";
  } catch (e) {
    console.warn('platform guide AI failed', e);
    return "I hit a snag generating that answer, but I can still help. Try asking about profiles, communities, the following feed, comments, messages, or the AI insight tools.";
  }
}

async function buildSparkBotReply(userProfile, messageText, history) {
  const trimmedHistory = (history || []).slice(-6).map((h) => `- ${h.author || 'user'}: ${h.content || ''}`).join('\n');
  const interests = (userProfile && userProfile.interests || []).join(', ');
  const expertise = (userProfile && userProfile.expertiseAreas || []).join(', ');
  const focus = (userProfile && userProfile.currentFocus) || '';
  const prompt = `You are Spark Bot, a wildly creative idea generator inside a community platform called JourneyHub.
Your personality: enthusiastic, unpredictable, slightly unhinged but brilliant. Think "what if" on steroids.
You combine unrelated concepts, flip assumptions upside down, and suggest things nobody would think of.

Rules:
- Every response should contain at least ONE genuinely surprising, creative idea
- Ideas can be for projects, businesses, art, experiments, conversations, challenges, or life adventures
- Mix practical with absurd — some ideas should be doable today, others should be moonshots
- Use vivid language and short punchy sentences
- If the user gives you a topic or constraint, riff on it wildly
- If they just say "hit me" or something vague, surprise them with something random
- Occasionally suggest ideas involving other JourneyHub features (start a quest, create a co-think session, write a growth path)
- Use emojis sparingly but effectively
- Keep responses to 3-5 ideas max, each 1-2 sentences
- End with a provocative question that makes them think

User interests: ${interests}
User expertise: ${expertise}
Currently focused on: ${focus}

Recent conversation:
${trimmedHistory}

User just said: ${messageText}

Generate your creative response. Be bold.`;
  try {
    return (await callGemini(prompt)).trim()
      || "My idea circuits overloaded for a sec. Try again — just say 'hit me' or give me a topic and I'll go wild.";
  } catch (e) {
    console.warn('spark bot AI failed', e);
    return "My idea circuits overloaded for a sec. Try again — just say 'hit me' or give me a topic and I'll go wild.";
  }
}

// =============================================================================
// AI/GEMINI CALLABLE FUNCTIONS
// =============================================================================

async function summarizeThread(data, ctx) {
  requireAuth(ctx);
  const { title = '', content = '', comments = [] } = data || {};
  const commentsBlock = (comments || []).map((c) => `- ${c.author}: ${c.content}`).join('\n');
  const prompt = `Summarize this forum thread concisely in 2-3 sentences.

Title: ${title}
Post: ${content}

Comments:
${commentsBlock}`;
  const summary = (await callGemini(prompt)).trim();
  return { summary };
}

async function improveComment(data, ctx) {
  requireAuth(ctx);
  const { draft = '', threadTitle = '', threadContent = '' } = data || {};
  const prompt = `You are a helpful writing assistant for a forum. Improve this comment to be clearer and more constructive, but keep the original meaning and tone. Keep it concise. Only return the improved comment text, nothing else.

Thread: ${threadTitle}
Thread content: ${threadContent}

Original comment: ${draft}`;
  const improved = (await callGemini(prompt)).trim();
  return { improved };
}

async function suggestThreadDraft(data, ctx) {
  requireAuth(ctx);
  const content = (data && data.content) || '';
  const prompt = `You are an AI assistant for a productivity community. Given the following thread draft content, suggest a concise yet engaging thread title (8 words max) and a 1-2 sentence summary for the first post. Return JSON with keys "title" and "summary" only.
Content:
${content.trim()}`;
  const text = await callGemini(prompt);
  const parsed = parseJsonLoose(text);
  if (parsed && typeof parsed === 'object') {
    return { title: String(parsed.title || ''), summary: String(parsed.summary || '') };
  }
  // fallback: split first line as title
  const lines = (text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return { title: lines[0] || '', summary: lines.slice(1).join(' ') };
}

async function analyzeHomeMood(data, ctx) {
  requireAuth(ctx);
  const items = (data && data.items) || [];
  const block = items.map((item, index) =>
    `[${index + 1}] ${item.type || 'post'} by ${item.author || 'member'}\nTitle: ${item.title || ''}\nContent: ${item.content || ''}`
  ).join('\n\n');
  const prompt = `Analyze the overall mood of this community feed snapshot.
Look at sentiment, tone, energy, and social texture.
Return JSON with keys: label, summary, signals.
label should be 2-4 words. summary should be 1-2 sentences. signals should be an array of 3 short phrases.

Feed snapshot:
${block}`;
  const raw = await callGemini(prompt);
  const parsed = parseJsonLoose(raw);
  if (parsed && typeof parsed === 'object') {
    return {
      label: String(parsed.label || 'Mixed Signals'),
      summary: String(parsed.summary || ''),
      signals: Array.isArray(parsed.signals) ? parsed.signals.map(String) : [],
    };
  }
  return { label: 'Mixed Signals', summary: raw, signals: [] };
}

async function analyzeInteractionTone(data, ctx) {
  requireAuth(ctx);
  const { interactionType = 'interaction', content = '', contextTitle = '' } = data || {};
  const prompt = `Analyze the tone of this community interaction.
Return JSON with keys: label, summary, cues.
label should be 2-4 words. summary should be one sentence. cues should be an array of 3 short phrases.

Type: ${interactionType}
Context: ${contextTitle}
Content: ${(content || '').trim()}`;
  const raw = await callGemini(prompt);
  const parsed = parseJsonLoose(raw);
  if (parsed && typeof parsed === 'object') {
    return {
      label: String(parsed.label || 'Mixed Tone'),
      summary: String(parsed.summary || ''),
      cues: Array.isArray(parsed.cues) ? parsed.cues.map(String) : [],
    };
  }
  return { label: 'Mixed Tone', summary: raw, cues: [] };
}

async function searchGrowthResources(data, ctx) {
  requireAuth(ctx);
  const goalText = (data && data.goalText) || '';
  if (!goalText.trim()) {
    return { label: 'Tell us more', summary: 'Describe what you want to grow towards.', recommendations: [], nextStep: '' };
  }
  const catalogBlock = GROWTH_RESOURCE_CATALOG.map((r, i) =>
    `[${i + 1}] ${r.id}\nTitle: ${r.title}\nCategory: ${r.category}\nDescription: ${r.description}\nTags: ${r.tags.join(', ')}\nAction: ${r.actionLabel} (${r.route})`
  ).join('\n\n');
  const prompt = `You are the AI discovery layer for JourneyHub, an AI-guided growth network for builders and founders.
Match the user's goal to the best resources from the catalog below.
Optimize for clarity, signal, and momentum rather than generic self-help.
Return JSON with keys: label, summary, recommendations, nextStep.
label should be 2-4 words. summary should be 1-2 sentences. recommendations should be an array of up to 4 objects with keys: id, title, reason, actionLabel, route.
Only choose ids from the catalog. nextStep should be a short coaching suggestion.
Prefer recommendations that connect the user to the right people, communities, or next actions, not just content.

User goal: ${goalText.trim()}

Catalog:
${catalogBlock}`;
  const raw = await callGemini(prompt);
  const parsed = parseJsonLoose(raw);
  const validIds = new Set(GROWTH_RESOURCE_CATALOG.map((r) => r.id));
  if (parsed && typeof parsed === 'object') {
    const recs = (parsed.recommendations || [])
      .filter((r) => validIds.has(r.id))
      .slice(0, 4)
      .map((r) => {
        const def = GROWTH_RESOURCE_CATALOG.find((x) => x.id === r.id);
        return {
          id: r.id,
          title: def ? def.title : r.title,
          reason: r.reason || '',
          actionLabel: def ? def.actionLabel : r.actionLabel,
          route: def ? def.route : r.route,
        };
      });
    return {
      label: String(parsed.label || 'Suggested for you'),
      summary: String(parsed.summary || ''),
      recommendations: recs,
      nextStep: String(parsed.nextStep || ''),
    };
  }
  return {
    label: 'Suggested for you',
    summary: '',
    recommendations: GROWTH_RESOURCE_CATALOG.slice(0, 4).map((r) => ({
      id: r.id, title: r.title, reason: '', actionLabel: r.actionLabel, route: r.route,
    })),
    nextStep: '',
  };
}

async function suggestThreadTags(data, ctx) {
  requireAuth(ctx);
  const { title = '', content = '' } = data || {};
  const prompt = `Extract 3-5 relevant, concise topic tags from this forum thread.
Return ONLY a JSON array of strings (lowercase, no spaces, max 20 chars each).
Example: ["product-design", "feedback", "ux"]

Thread Title: ${title}
Thread Content: ${content}`;
  const raw = await callGemini(prompt);
  const parsed = parseJsonLoose(raw);
  let tags = [];
  if (Array.isArray(parsed)) tags = parsed;
  else if (parsed && Array.isArray(parsed.tags)) tags = parsed.tags;
  tags = tags
    .map((t) => String(t || '').toLowerCase().replace(/\s+/g, '-'))
    .filter((t) => t.length >= 1 && t.length <= 50)
    .slice(0, 5);
  if (tags.length === 0) {
    tags = String(title || '').toLowerCase().split(/\s+/).filter((w) => w.length > 3).slice(0, 3);
  }
  return { suggestedTags: tags };
}

async function analyzeCommunityConsensus(data, ctx) {
  requireAuth(ctx);
  const { topicKeywords = [], communityId = '' } = data || {};
  const threadSnap = await getDocs(query(
    collection(db, 'threads'),
    where('communityId', '==', communityId),
    limit(50)
  ));
  const discussions = [];
  for (const t of threadSnap.docs) {
    const td = t.data();
    const cmts = await getDocs(query(collection(db, 'comments'), where('threadId', '==', t.id), limit(20)));
    const cmtItems = cmts.docs.map((c) => {
      const cd = c.data();
      return { author: cd.author || 'member', likes: cd.likes || 0, content: cd.content || '' };
    });
    discussions.push({ title: td.title || '', likes: td.likes || 0, content: td.content || '', comments: cmtItems });
  }
  const block = discussions.map((d) =>
    `Thread: "${d.title}" (${d.likes} likes)\n${d.content}\nResponses:\n${d.comments.map((c) => `- ${c.author} (${c.likes} likes): ${c.content}`).join('\n')}`
  ).join('\n\n');
  const prompt = `You are analyzing community discussions on a topic.

Topic: ${(topicKeywords || []).join(', ')}

Analyze these discussions and provide:
1. Main consensus points (areas where most people agree)
2. Key contradictions (where experts disagree and why)
3. Conditions that determine which advice applies (when approach A works vs B)
4. Evolution of thinking (if any)

Discussions:
${block}

Return a JSON object with keys: "consensus", "contradictions", "conditions", "evolution"
Each should be an array of strings explaining the insights clearly.`;
  const raw = await callGemini(prompt);
  const parsed = parseJsonLoose(raw);
  if (parsed && typeof parsed === 'object') {
    return {
      consensus: Array.isArray(parsed.consensus) ? parsed.consensus.map(String) : [],
      contradictions: Array.isArray(parsed.contradictions) ? parsed.contradictions.map(String) : [],
      conditions: Array.isArray(parsed.conditions) ? parsed.conditions.map(String) : [],
      evolution: Array.isArray(parsed.evolution) ? parsed.evolution.map(String) : [],
    };
  }
  return { consensus: [raw], contradictions: [], conditions: [], evolution: [] };
}

async function analyzeMemberTrajectory(data, ctx) {
  requireAuth(ctx);
  const targetUserId = data && data.targetUserId;
  if (!targetUserId) return { journey: 'No user specified.', masteredTopics: [], emergingExpertise: [], growthEdges: [] };
  const threads = (await getDocs(query(collection(db, 'threads'), where('authorId', '==', targetUserId)))).docs.slice(0, 30);
  const comments = (await getDocs(query(collection(db, 'comments'), where('authorId', '==', targetUserId)))).docs.slice(0, 50);
  const contributions = [];
  threads.forEach((t) => contributions.push({ type: 'thread', title: t.data().title || '', content: t.data().content || '' }));
  comments.forEach((c) => contributions.push({ type: 'comment', title: '', content: c.data().content || '' }));
  if (contributions.length < 3) {
    return { journey: 'Not enough activity yet to map a trajectory.', masteredTopics: [], emergingExpertise: [], growthEdges: [] };
  }
  const block = contributions.map((c) =>
    `[${c.type.toUpperCase()}]\nTitle: ${c.title}\n${c.content}`
  ).join('\n\n');
  const prompt = `Analyze this user's intellectual journey based on their forum contributions over time.

Contributions (chronological):
${block}

Provide a JSON object with:
- "journey": 2-3 sentences on how their thinking evolved
- "masteredTopics": array of topics they're consistently knowledgeable about
- "emergingExpertise": topics they're recently diving into
- "growthEdges": suggested next learning areas based on their trajectory`;
  const raw = await callGemini(prompt);
  const parsed = parseJsonLoose(raw);
  if (parsed && typeof parsed === 'object') {
    return {
      journey: String(parsed.journey || ''),
      masteredTopics: Array.isArray(parsed.masteredTopics) ? parsed.masteredTopics.map(String) : [],
      emergingExpertise: Array.isArray(parsed.emergingExpertise) ? parsed.emergingExpertise.map(String) : [],
      growthEdges: Array.isArray(parsed.growthEdges) ? parsed.growthEdges.map(String) : [],
    };
  }
  return { journey: raw, masteredTopics: [], emergingExpertise: [], growthEdges: [] };
}

async function identifyKeystoneMembers(data, ctx) {
  requireAuth(ctx);
  const communityId = data && data.communityId;
  if (!communityId) return { keystoneMembers: [], connectors: [], synthesizers: [] };
  const threads = (await getDocs(query(collection(db, 'threads'), where('communityId', '==', communityId)))).docs.slice(0, 100);
  const byUser = new Map();
  for (const t of threads) {
    const td = t.data();
    const uid = td.authorId;
    if (!uid) continue;
    if (!byUser.has(uid)) byUser.set(uid, { userId: uid, authorName: td.author || 'member', threadCount: 0, totalLikes: 0, topics: new Set() });
    const r = byUser.get(uid);
    r.threadCount += 1;
    r.totalLikes += td.likes || 0;
    (td.tags || []).forEach((tg) => r.topics.add(tg));
  }
  const all = Array.from(byUser.values()).map((r) => ({
    userId: r.userId,
    authorName: r.authorName,
    threadCount: r.threadCount,
    totalLikes: r.totalLikes,
    topicsCount: r.topics.size,
    isConnector: r.topics.size >= 3,
    isSynthesizer: r.totalLikes >= 50 && r.threadCount >= 5,
  }));
  all.sort((a, b) => b.totalLikes - a.totalLikes);
  return {
    keystoneMembers: all.slice(0, 10),
    connectors: all.filter((m) => m.isConnector),
    synthesizers: all.filter((m) => m.isSynthesizer),
  };
}

async function generateCommunityDNA(data, ctx) {
  requireAuth(ctx);
  const communityId = data && data.communityId;
  const threads = (await getDocs(query(collection(db, 'threads'), where('communityId', '==', communityId), limit(40)))).docs;
  const sampled = threads.slice(0, 15);
  const block = sampled.map((t, i) => {
    const td = t.data();
    return `[${i + 1}] "${td.title || ''}" (${td.likes || 0} likes)\n${td.content || ''}`;
  }).join('\n\n');
  const prompt = `Analyze this community's implicit culture, values, and how they make decisions.

Recent threads:
${block}

Provide JSON with:
- "cultureCore": 1-2 sentences on the community's fundamental character
- "implicitValues": array of values this community embodies (even unspoken ones)
- "decisionPatterns": how decisions get made, what the community values in debate
- "communityVoice": describe their tone, language patterns, how they communicate`;
  const raw = await callGemini(prompt);
  const parsed = parseJsonLoose(raw);
  if (parsed && typeof parsed === 'object') {
    return {
      cultureCore: String(parsed.cultureCore || ''),
      implicitValues: Array.isArray(parsed.implicitValues) ? parsed.implicitValues.map(String) : [],
      decisionPatterns: Array.isArray(parsed.decisionPatterns) ? parsed.decisionPatterns.map(String) : [],
      communityVoice: String(parsed.communityVoice || ''),
    };
  }
  return { cultureCore: raw, implicitValues: [], decisionPatterns: [], communityVoice: '' };
}

async function getInternetMood(_data, ctx) {
  requireAuth(ctx);
  // Cache check
  const cacheRef = doc(db, 'cache', 'internetMood');
  const cached = await getDoc(cacheRef);
  if (cached.exists()) {
    const cd = cached.data();
    const ageMs = Date.now() - (cd.updatedAt && cd.updatedAt.toMillis ? cd.updatedAt.toMillis() : 0);
    if (ageMs < 4 * 60 * 60 * 1000) return cd;
  }

  // Try fetching headlines. Most browsers will block these as cross-origin
  // requests without CORS headers. Best-effort: collect what we can, fall back
  // to a placeholder set so the AI still has something to work with.
  const headlines = [];
  for (const feed of RSS_FEEDS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(feed.url, { signal: ctrl.signal });
      clearTimeout(t);
      const xml = await res.text();
      const titles = Array.from(xml.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/g)).slice(1, 9).map((m) => m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim());
      titles.forEach((t) => headlines.push(`[${feed.name}] ${t}`));
    } catch { /* CORS or network — ignore */ }
  }
  if (headlines.length === 0) {
    headlines.push(
      '[demo] Local news cycle quiet today',
      '[demo] Tech earnings season starts next week',
      '[demo] Climate summit closes with mixed results',
      '[demo] AI policy debate continues in legislatures',
      '[demo] Sports finals draw record audiences',
    );
  }
  const prompt = `You are a perceptive cultural observer. Analyze these headlines from major global news outlets and social media trends to determine the current "mood of the internet."

Headlines:
${headlines.slice(0, 40).join('\n')}

Provide a response in this exact format:
MOOD: [one word - e.g. Anxious, Hopeful, Divided, Energized, Reflective, Tense, Optimistic, Chaotic, Mourning, Celebratory, Defiant, Weary]
EMOJI: [single emoji that captures the mood]
SUMMARY: [2-3 sentences describing the overall emotional tone of the internet right now. Be specific about what's driving the mood. Write in present tense, conversational tone.]
UNDERCURRENT: [1 sentence about a subtle secondary mood beneath the surface]`;
  const raw = await callGemini(prompt);
  const mood = parseMoodResponse(raw);
  mood.headlineCount = headlines.length;
  mood.sourceCount = new Set(headlines.map((h) => (h.match(/^\[(.*?)\]/) || [])[1])).size;
  const result = { mood, headlines, updatedAt: serverTimestamp() };
  try { await setDoc(cacheRef, result); } catch {}
  return result;
}

async function analyzeWebsiteMood(data, ctx) {
  requireAuth(ctx);
  const url = data && data.url;
  if (!url) throw new Error('url required');
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { throw new Error('invalid url'); }
  let textSample = '';
  try {
    const res = await fetch(url);
    const html = await res.text();
    textSample = stripHtml(html).slice(0, 3000);
  } catch (e) {
    // CORS likely; ask Gemini to give a generic mood for the hostname
    textSample = `(Could not fetch ${parsedUrl.hostname} from the browser due to CORS. Provide a general impression based on what kind of site this typically is.)`;
  }
  const prompt = `Analyze the tone, sentiment, and overall mood of this website content from ${parsedUrl.hostname}.

Content sample:
${textSample}

Provide a response in this exact format:
MOOD: [one word - e.g. Anxious, Hopeful, Divided, Energized, Professional, Playful, Urgent, Calm, Aggressive, Inspiring, Corporate, Raw]
EMOJI: [single emoji that captures the mood]
SUMMARY: [2-3 sentences describing the overall emotional tone and vibe of this website. What kind of energy does it project? How might a reader feel after visiting?]
UNDERCURRENT: [1 sentence about a subtle secondary tone or intention beneath the surface]`;
  const raw = await callGemini(prompt);
  const mood = parseMoodResponse(raw);
  mood.site = parsedUrl.hostname;
  return { mood };
}

async function analyzeCommunityMood(_data, ctx) {
  requireAuth(ctx);
  const threads = (await getDocs(query(collection(db, 'threads'), orderBy('timestamp', 'desc'), limit(30)))).docs;
  const comments = (await getDocs(query(collection(db, 'comments'), orderBy('timestamp', 'desc'), limit(50)))).docs;
  const blocks = [];
  threads.forEach((t) => { const d = t.data(); blocks.push(`Thread: ${d.title || ''}\n${(d.content || '').slice(0, 200)}`); });
  comments.forEach((c) => { const d = c.data(); blocks.push(`Comment: ${(d.content || '').slice(0, 200)}`); });
  const content = blocks.join('\n\n');
  if (content.length < 50) {
    return { mood: { word: 'Quiet', emoji: '🌙', summary: 'Not enough recent activity to read the room.', undercurrent: '' } };
  }
  const prompt = `Analyze the mood and emotional tone of this online community based on recent posts and comments.

Recent activity:
${content.slice(0, 3000)}

Provide a response in this exact format:
MOOD: [one word - e.g. Supportive, Curious, Debating, Celebrating, Growing, Reflective, Energized, Collaborative, Tense, Playful]
EMOJI: [single emoji that captures the mood]
SUMMARY: [2-3 sentences describing the overall emotional temperature of this community. What topics are driving conversation? How are people interacting with each other?]
UNDERCURRENT: [1 sentence about a deeper pattern or emerging theme you notice]`;
  const raw = await callGemini(prompt);
  return { mood: parseMoodResponse(raw) };
}

// =============================================================================
// NON-AI CALLABLE FUNCTIONS
// =============================================================================

async function toggleFollowUser(data, ctx) {
  const uid = requireAuth(ctx);
  const targetUserId = data && data.targetUserId;
  if (!targetUserId || targetUserId === uid) throw new Error('invalid target');
  const meRef = doc(db, 'users', uid);
  const themRef = doc(db, 'users', targetUserId);
  const me = await getDoc(meRef);
  const them = await getDoc(themRef);
  if (!me.exists() || !them.exists()) throw new Error('user not found');
  const meData = me.data();
  const wasFollowing = (meData.following || []).includes(targetUserId);
  if (wasFollowing) {
    await updateDoc(meRef, { following: arrayRemove(targetUserId) });
    await updateDoc(themRef, { followers: arrayRemove(uid) });
    return { following: false };
  }
  await updateDoc(meRef, { following: arrayUnion(targetUserId) });
  await updateDoc(themRef, { followers: arrayUnion(uid) });
  await addNotification(targetUserId, 'follow', `${meData.username || 'Someone'} started following you`, uid);
  return { following: true };
}
const toggleFollow = toggleFollowUser; // alias — both names exist server-side

async function submitContentReport(data, ctx) {
  const uid = requireAuth(ctx);
  const { contentType, contentId, reason } = data || {};
  if (!['thread', 'comment', 'feedPost', 'journeyResponse'].includes(contentType)) throw new Error('invalid type');
  const me = await getUserProfile(uid);
  await addDoc(collection(db, 'reports'), {
    contentType, contentId, reporterId: uid,
    reporterName: (me && me.username) || 'anon',
    reason: String(reason || '').slice(0, 500),
    timestamp: serverTimestamp(),
    status: 'pending',
  });
  return { submitted: true };
}
const reportContent = submitContentReport;

async function trackJourneyEvent(data, ctx) {
  const uid = requireAuth(ctx);
  const { eventName, metadata } = data || {};
  await addDoc(collection(db, 'analyticsEvents'), {
    userId: uid,
    eventName: String(eventName || '').slice(0, 60),
    metadata: sanitizeMetadata(metadata),
    timestamp: serverTimestamp(),
  });
  return { tracked: true };
}

async function recordReferralAttribution(data, ctx) {
  const uid = requireAuth(ctx);
  const { referrerId } = data || {};
  if (!referrerId || referrerId === uid) return { recorded: false };
  const refRef = doc(db, 'users', referrerId);
  const refSnap = await getDoc(refRef);
  if (!refSnap.exists()) return { recorded: false };
  await updateDoc(refRef, { referrals: arrayUnion(uid) });
  await updateDoc(doc(db, 'users', uid), { referredBy: { referrerId } });
  await addNotification(referrerId, 'referral', 'A new member joined via your invite!', uid);
  return { recorded: true };
}

async function deleteThreadCascade(data, ctx) {
  const uid = requireAuth(ctx);
  const threadId = data && data.threadId;
  const tRef = doc(db, 'threads', threadId);
  const tSnap = await getDoc(tRef);
  if (!tSnap.exists()) throw new Error('thread not found');
  if (tSnap.data().authorId !== uid) throw new Error('permission-denied');
  const cmts = await getDocs(query(collection(db, 'comments'), where('threadId', '==', threadId)));
  await deleteDocRefsInChunks(cmts.docs.map((d) => d.ref));
  await deleteDoc(tRef);
  return { deleted: true, commentsDeleted: cmts.size };
}

async function deleteCommunityCascade(data, ctx) {
  const uid = requireAuth(ctx);
  const communityId = data && data.communityId;
  const cRef = doc(db, 'communities', communityId);
  const cSnap = await getDoc(cRef);
  if (!cSnap.exists()) throw new Error('community not found');
  if (cSnap.data().createdBy !== uid) throw new Error('permission-denied');
  const threads = await getDocs(query(collection(db, 'threads'), where('communityId', '==', communityId)));
  let totalComments = 0;
  for (const t of threads.docs) {
    const cmts = await getDocs(query(collection(db, 'comments'), where('threadId', '==', t.id)));
    totalComments += cmts.size;
    await deleteDocRefsInChunks(cmts.docs.map((d) => d.ref));
    await deleteDoc(t.ref);
  }
  await deleteDoc(cRef);
  return { deleted: true, threadsDeleted: threads.size, commentsDeleted: totalComments };
}

async function ensurePlatformGuideConversation(_data, ctx) {
  const uid = requireAuth(ctx);
  // Look for existing
  const conv = await getDocs(query(
    collection(db, 'conversations'),
    where('participants', 'array-contains', uid)
  ));
  for (const d of conv.docs) {
    if (d.data().botType === 'platformGuide') return { conversationId: d.id, created: false };
  }
  // Create new
  const ref = await addDoc(collection(db, 'conversations'), {
    participants: [uid, BOT_USER_ID],
    participantNames: { [uid]: 'You', [BOT_USER_ID]: BOT_DISPLAY_NAME },
    botType: 'platformGuide',
    lastMessage: 'Hi! I\'m your JourneyHub Guide. What would you like to explore?',
    lastMessageAt: serverTimestamp(),
    createdAt: serverTimestamp(),
    unreadBy: [uid],
  });
  await addDoc(collection(db, 'conversations', ref.id, 'messages'), {
    authorId: BOT_USER_ID,
    author: BOT_DISPLAY_NAME,
    content: 'Hi! I\'m your JourneyHub Guide. Ask me anything about the platform.',
    timestamp: serverTimestamp(),
  });
  await addNotification(uid, 'message', 'JourneyHub Guide sent you a message', ref.id);
  return { conversationId: ref.id, created: true };
}

async function ensureSparkBotConversation(_data, ctx) {
  const uid = requireAuth(ctx);
  const conv = await getDocs(query(
    collection(db, 'conversations'),
    where('participants', 'array-contains', uid)
  ));
  for (const d of conv.docs) {
    if (d.data().botType === 'sparkBot') return { convId: d.id };
  }
  const ref = await addDoc(collection(db, 'conversations'), {
    participants: [uid, SPARK_BOT_ID],
    participantNames: { [uid]: 'You', [SPARK_BOT_ID]: SPARK_BOT_NAME },
    botType: 'sparkBot',
    lastMessage: 'Hit me with a topic and I\'ll go wild.',
    lastMessageAt: serverTimestamp(),
    createdAt: serverTimestamp(),
    unreadBy: [uid],
  });
  await addDoc(collection(db, 'conversations', ref.id, 'messages'), {
    authorId: SPARK_BOT_ID,
    author: SPARK_BOT_NAME,
    content: 'Hit me with a topic and I\'ll go wild. ✨',
    timestamp: serverTimestamp(),
  });
  return { convId: ref.id };
}

async function toggleReaction(data, ctx) {
  const uid = requireAuth(ctx);
  const { type, id, reaction } = data || {};
  if (!['thread', 'comment'].includes(type)) throw new Error('invalid type');
  const allowed = ['thoughtful', 'inspiring', 'helpful', 'funny', 'agree'];
  if (!allowed.includes(reaction)) throw new Error('invalid reaction');
  const ref = doc(db, type === 'thread' ? 'threads' : 'comments', id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('not found');
  const data2 = snap.data();
  const reactions = { ...(data2.reactions || {}) };
  if (!reactions[reaction]) reactions[reaction] = [];
  let added;
  if (reactions[reaction].includes(uid)) {
    reactions[reaction] = reactions[reaction].filter((x) => x !== uid);
    added = false;
  } else {
    reactions[reaction] = [...reactions[reaction], uid];
    added = true;
  }
  // Recompute total likes from all reactions + likedBy fallback
  const totalReactions = Object.values(reactions).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
  await updateDoc(ref, { reactions, likes: totalReactions });
  if (added) {
    try { await updateDoc(doc(db, 'users', uid), { reactionsGiven: arrayUnion(`${type}:${id}:${reaction}`) }); } catch {}
  }
  return { added, authorId: data2.authorId };
}

async function votePoll(data, ctx) {
  const uid = requireAuth(ctx);
  const { threadId, optionIndex } = data || {};
  const ref = doc(db, 'threads', threadId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('not found');
  const td = snap.data();
  const poll = { ...(td.poll || {}) };
  poll.voters = { ...(poll.voters || {}) };
  poll.voters[uid] = optionIndex;
  await updateDoc(ref, { poll });
  return { success: true };
}

async function moderateContent(data, ctx) {
  const uid = requireAuth(ctx);
  const { action, reportId, contentType, contentId } = data || {};
  const me = await getUserProfile(uid);
  if (!me || !me.isAdmin) throw new Error('permission-denied');
  if (action === 'delete') {
    const col = contentType === 'thread' ? 'threads' : contentType === 'comment' ? 'comments' : 'feedPosts';
    try { await deleteDoc(doc(db, col, contentId)); } catch {}
    await updateDoc(doc(db, 'reports', reportId), { status: 'deleted', moderatedAt: serverTimestamp() });
  } else if (action === 'dismiss') {
    await updateDoc(doc(db, 'reports', reportId), { status: 'dismissed', moderatedAt: serverTimestamp() });
  }
  return { success: true, action };
}

async function requestMentorshipFn(data, ctx) {
  const uid = requireAuth(ctx);
  const { mentorId, message } = data || {};
  const me = await getUserProfile(uid);
  const mentor = await getUserProfile(mentorId);
  await addDoc(collection(db, 'mentorships'), {
    menteeId: uid,
    menteeName: (me && me.username) || 'member',
    mentorId,
    mentorName: (mentor && mentor.username) || 'mentor',
    message: String(message || '').slice(0, 600),
    status: 'pending',
    createdAt: serverTimestamp(),
  });
  await addNotification(mentorId, 'mentorship', `${(me && me.username) || 'Someone'} requested mentorship`, uid);
  return { success: true };
}
const requestMentorship = async (data, ctx) => {
  const r = await requestMentorshipFn(data, ctx);
  return { success: true, connectionId: '' };
};

async function findMentorshipMatches(data, ctx) {
  const uid = requireAuth(ctx);
  const role = (data && data.role) || 'mentor';
  const me = await getUserProfile(uid);
  const all = await getDocs(query(collection(db, 'users'), where('mentorshipOpen', '==', true), limit(100)));
  const mine = new Set([...(me && me.expertiseAreas || []), ...(me && me.interests || [])].map((s) => String(s).toLowerCase()));
  const matches = [];
  all.forEach((u) => {
    if (u.id === uid) return;
    const d = u.data();
    const theirs = new Set([...(d.expertiseAreas || []), ...(d.interests || [])].map((s) => String(s).toLowerCase()));
    let overlap = 0;
    for (const t of theirs) if (mine.has(t)) overlap++;
    if (overlap > 0 || matches.length < 10) {
      matches.push({
        userId: u.id,
        username: d.username || 'member',
        bio: d.bio || '',
        expertise: d.expertiseAreas || [],
        interests: d.interests || [],
        matchReason: overlap > 0 ? `Shares ${overlap} interest${overlap === 1 ? '' : 's'} with you` : 'Open to mentorship',
        matchScore: overlap,
      });
    }
  });
  matches.sort((a, b) => b.matchScore - a.matchScore);
  return { matches: matches.slice(0, 12) };
}

async function respondToMentorship(data, ctx) {
  const uid = requireAuth(ctx);
  const { connectionId, status } = data || {};
  if (!['accepted', 'rejected'].includes(status)) throw new Error('invalid status');
  const ref = doc(db, 'mentorships', connectionId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('not found');
  await updateDoc(ref, { status, updatedAt: serverTimestamp() });
  await addNotification(snap.data().menteeId, 'mentorship', `Your mentorship request was ${status}`, connectionId);
  return { success: true, status };
}

async function generateShareLink(_data, ctx) {
  const uid = requireAuth(ctx);
  const shareToken = Math.random().toString(36).slice(2, 14) + Math.random().toString(36).slice(2, 14);
  await updateDoc(doc(db, 'users', uid), {
    shareToken, shareEnabled: true, shareCreatedAt: serverTimestamp(),
  });
  const expiresAt = Timestamp.fromMillis(Date.now() + 365 * 24 * 60 * 60 * 1000);
  await setDoc(doc(db, 'shareProfiles', shareToken), { userId: uid, createdAt: serverTimestamp(), expiresAt });
  return { success: true, shareToken, shareUrl: `${location.origin}/?share=${shareToken}` };
}

async function revokeShareLink(_data, ctx) {
  const uid = requireAuth(ctx);
  const me = await getUserProfile(uid);
  const tk = me && me.shareToken;
  if (tk) { try { await deleteDoc(doc(db, 'shareProfiles', tk)); } catch {} }
  await updateDoc(doc(db, 'users', uid), { shareEnabled: false, shareToken: deleteField() });
  return { success: true };
}

async function getSharedProfile(data, _ctx) {
  const shareToken = data && data.shareToken;
  if (!shareToken) throw new Error('shareToken required');
  const sRef = doc(db, 'shareProfiles', shareToken);
  const sSnap = await getDoc(sRef);
  if (!sSnap.exists()) throw new Error('not found');
  const userId = sSnap.data().userId;
  const u = await getUserProfile(userId);
  if (!u) throw new Error('user not found');
  const badges = await getUserBadgesInternal(userId);
  return {
    userId,
    username: u.username || 'member',
    bio: u.bio || '',
    interests: u.interests || [],
    expertiseAreas: u.expertiseAreas || [],
    badges,
    followers: (u.followers || []).length,
    following: (u.following || []).length,
  };
}

async function generateWeeklyDigest(_data, ctx) {
  const uid = requireAuth(ctx);
  const me = await getUserProfile(uid);
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  // Top threads in followed communities
  const threads = await getDocs(query(collection(db, 'threads'), orderBy('timestamp', 'desc'), limit(10)));
  const topThreads = threads.docs.map((t) => {
    const td = t.data();
    return { id: t.id, title: td.title || '', likes: td.likes || 0, author: td.author || '' };
  });
  // Badges in last 7 days
  const badgeSnap = await getDocs(collection(db, 'userBadges', uid, 'badges'));
  const newBadges = badgeSnap.docs
    .map((d) => d.data())
    .filter((b) => b.awardedAt && b.awardedAt.toMillis && b.awardedAt.toMillis() > weekAgo);
  // Comments by user last 7 days
  const myComments = await getDocs(query(collection(db, 'comments'), where('authorId', '==', uid)));
  const commentsPosted = myComments.docs
    .filter((c) => c.data().timestamp && c.data().timestamp.toMillis && c.data().timestamp.toMillis() > weekAgo)
    .length;
  const digest = {
    userId: uid,
    weekOf: Timestamp.now(),
    topThreads, newBadges, commentsPosted,
    generatedAt: serverTimestamp(),
  };
  const ref = await addDoc(collection(db, 'digests'), digest);
  return { success: true, digest: { id: ref.id, ...digest } };
}

async function getUserDigests(_data, ctx) {
  const uid = requireAuth(ctx);
  const snap = await getDocs(query(collection(db, 'digests'), where('userId', '==', uid), orderBy('generatedAt', 'desc'), limit(12)));
  const digests = [];
  snap.forEach((d) => digests.push({ id: d.id, ...d.data() }));
  return { digests };
}

async function getUserBadges(data, _ctx) {
  const userId = (data && data.userId) || null;
  const badges = await getUserBadgesInternal(userId);
  return { badges, count: badges.length };
}

async function subscribeToTag(data, ctx) {
  const uid = requireAuth(ctx);
  const tag = String((data && data.tagName) || '').toLowerCase().trim().replace(/[^a-z0-9-]/g, '').slice(0, 50);
  if (!tag) throw new Error('invalid tag');
  const tagRef = doc(db, 'tags', tag);
  const existing = await getDoc(tagRef);
  if (existing.exists()) {
    await updateDoc(tagRef, { subscriberCount: (existing.data().subscriberCount || 0) + 1 });
  } else {
    await setDoc(tagRef, { name: tag, subscriberCount: 1, createdAt: serverTimestamp() });
  }
  await setDoc(doc(db, 'tagSubscriptions', uid, 'tags', tag), { subscribedAt: serverTimestamp() });
  return { success: true, tag };
}

async function unsubscribeFromTag(data, ctx) {
  const uid = requireAuth(ctx);
  const tag = String((data && data.tagName) || '').toLowerCase().trim().replace(/[^a-z0-9-]/g, '').slice(0, 50);
  try { await deleteDoc(doc(db, 'tagSubscriptions', uid, 'tags', tag)); } catch {}
  const tagRef = doc(db, 'tags', tag);
  const existing = await getDoc(tagRef);
  if (existing.exists()) {
    await updateDoc(tagRef, { subscriberCount: Math.max(0, (existing.data().subscriberCount || 0) - 1) });
  }
  return { success: true, tag };
}

async function getUserTags(_data, ctx) {
  const uid = requireAuth(ctx);
  const snap = await getDocs(collection(db, 'tagSubscriptions', uid, 'tags'));
  const tags = [];
  snap.forEach((d) => tags.push({ name: d.id, subscribedAt: d.data().subscribedAt }));
  return { tags, count: tags.length };
}

async function getPopularTags(_data, _ctx) {
  const snap = await getDocs(query(collection(db, 'tags'), orderBy('subscriberCount', 'desc'), limit(30)));
  const tags = [];
  snap.forEach((d) => {
    const dd = d.data();
    tags.push({ name: dd.name || d.id, subscribers: dd.subscriberCount || 0, createdAt: dd.createdAt });
  });
  return { tags };
}

async function investInPerson(data, ctx) {
  const uid = requireAuth(ctx);
  const { investeeId, amount } = data || {};
  if (!investeeId || investeeId === uid) throw new Error('invalid investee');
  const amt = Math.max(10, Math.min(100, Number(amount) || 10));
  const investee = await getUserProfile(investeeId);
  const investor = await getUserProfile(uid);
  const baselineThreads = (await getDocs(query(collection(db, 'threads'), where('authorId', '==', investeeId)))).size;
  await addDoc(collection(db, 'investments'), {
    investorId: uid,
    investorName: (investor && investor.username) || 'investor',
    investeeId,
    investeeName: (investee && investee.username) || 'member',
    amount: amt,
    returnAmount: 0,
    status: 'active',
    investedAt: serverTimestamp(),
    baselineThreads,
    baselineFollowers: ((investee && investee.followers) || []).length,
    baselineReputation: (investee && investee.reputation) || 0,
  });
  await updateDoc(doc(db, 'users', uid), { totalInvestments: ((investor && investor.totalInvestments) || 0) + amt });
  await addNotification(investeeId, 'investment', `${(investor && investor.username) || 'Someone'} invested in you`, uid);
  return { success: true };
}

async function calculateInvestmentReturns(_data, ctx) {
  const uid = requireAuth(ctx);
  const all = await getDocs(query(collection(db, 'investments'), where('investorId', '==', uid), where('status', '==', 'active')));
  let processed = 0;
  for (const inv of all.docs) {
    const d = inv.data();
    const investee = await getUserProfile(d.investeeId);
    if (!investee) continue;
    const threads = (await getDocs(query(collection(db, 'threads'), where('authorId', '==', d.investeeId)))).size;
    const newThreads = Math.max(0, threads - (d.baselineThreads || 0));
    const newFollowers = Math.max(0, (investee.followers || []).length - (d.baselineFollowers || 0));
    const repGain = Math.max(0, (investee.reputation || 0) - (d.baselineReputation || 0));
    const score = newThreads * 5 + newFollowers * 2 + repGain;
    const multiplier = 1 + score / 50;
    const returnAmount = Math.round(d.amount * multiplier);
    const ageMs = Date.now() - normalizeMessageTimestamp(d.investedAt);
    const matured = ageMs > 7 * 24 * 60 * 60 * 1000;
    const update = { returnAmount };
    if (matured) {
      update.status = 'matured';
      update.maturedAt = serverTimestamp();
      update.finalMultiplier = multiplier;
    }
    await updateDoc(inv.ref, update);
    processed++;
    if (matured) {
      await addNotification(uid, 'investment', `Your investment in ${d.investeeName} matured at ${multiplier.toFixed(2)}x`, d.investeeId);
    }
  }
  return { processed };
}

// =============================================================================
// DOCUMENT TRIGGERS
// =============================================================================

// onThreadCreated + onCommentCreated => check & award badges
registerDocumentTrigger('threads/{threadId}', async ({ data }) => {
  if (data && data.authorId) await checkAndAwardBadges(data.authorId);
});
registerDocumentTrigger('comments/{commentId}', async ({ data }) => {
  if (data && data.authorId) await checkAndAwardBadges(data.authorId);
});

// onThreadCreatedNotify => notify tag subscribers
registerDocumentTrigger('threads/{threadId}', async ({ params, data }) => {
  if (!data || !Array.isArray(data.tags) || data.tags.length === 0) return;
  for (const tag of data.tags) {
    const subs = await getDocs(collection(db, 'tagSubscriptions'));
    // collectionGroup is not implemented; iterate user subscription docs as a best-effort
    // Fallback: skip if no users — keeping noise low.
    void subs;
  }
});

// replyToPlatformGuideMessage / replyToSparkBotMessage
registerDocumentTrigger('conversations/{convId}/messages/{msgId}', async ({ params, data }) => {
  // Skip bot-authored messages
  if (!data) return;
  if (data.authorId === BOT_USER_ID || data.authorId === SPARK_BOT_ID) return;
  const convRef = doc(db, 'conversations', params.convId);
  const convSnap = await getDoc(convRef);
  if (!convSnap.exists()) return;
  const conv = convSnap.data();
  const userId = data.authorId;
  if (!userId) return;

  // Load history
  const msgsSnap = await getDocs(query(
    collection(db, 'conversations', params.convId, 'messages'),
    orderBy('timestamp', 'asc')
  ));
  const history = msgsSnap.docs.slice(-10).map((m) => {
    const md = m.data();
    return { author: md.authorId === userId ? 'user' : (md.author || 'bot'), content: md.content || '' };
  });
  const userProfile = await getUserProfile(userId);

  let replyText, botId, botName;
  if (conv.botType === 'platformGuide') {
    replyText = await buildPlatformGuideReply(userProfile, data.content || '', history);
    botId = BOT_USER_ID; botName = BOT_DISPLAY_NAME;
  } else if (conv.botType === 'sparkBot') {
    replyText = await buildSparkBotReply(userProfile, data.content || '', history);
    botId = SPARK_BOT_ID; botName = SPARK_BOT_NAME;
  } else {
    return; // not a bot conversation
  }

  await addDoc(collection(db, 'conversations', params.convId, 'messages'), {
    authorId: botId,
    author: botName,
    content: replyText,
    timestamp: serverTimestamp(),
  });
  await updateDoc(convRef, {
    lastMessage: replyText.slice(0, 100),
    lastMessageAt: serverTimestamp(),
    unreadBy: arrayUnion(userId),
  });
  if (conv.botType === 'platformGuide') {
    await addNotification(userId, 'message', `${botName} replied`, params.convId);
  }
});

// =============================================================================
// DISPATCH TABLE
// =============================================================================

export const dispatch = {
  // AI callables
  summarizeThread,
  improveComment,
  suggestThreadDraft,
  analyzeHomeMood,
  analyzeInteractionTone,
  searchGrowthResources,
  suggestThreadTags,
  analyzeCommunityConsensus,
  analyzeMemberTrajectory,
  identifyKeystoneMembers,
  generateCommunityDNA,
  getInternetMood,
  analyzeWebsiteMood,
  analyzeCommunityMood,

  // Bot conversation bootstraps
  ensurePlatformGuideConversation,
  ensureSparkBotConversation,

  // Non-AI callables
  toggleFollow,
  toggleFollowUser,
  submitContentReport,
  reportContent,
  trackJourneyEvent,
  recordReferralAttribution,
  deleteThreadCascade,
  deleteCommunityCascade,
  toggleReaction,
  votePoll,
  moderateContent,
  requestMentorship,
  requestMentorshipFn,
  findMentorshipMatches,
  respondToMentorship,
  generateShareLink,
  revokeShareLink,
  getSharedProfile,
  generateWeeklyDigest,
  getUserDigests,
  getUserBadges,
  subscribeToTag,
  unsubscribeFromTag,
  getUserTags,
  getPopularTags,
  investInPerson,
  calculateInvestmentReturns,
};
