#!/usr/bin/env python3
"""Pure topic builder: INPUT_JSON EMBEDDINGS_FLOAT32 OUTPUT_JSON.

notes: [{id, userId, createdAt (epoch milliseconds), replyId, renoteId,
text, terms, source (seed/link/embedding), embeddingIndex (nullable)}], parents: [{id, replyId, renoteId,
text}], terms: [{term, score}], dim, meanVec (nullable), now, constants.
Embeddings use input embeddingDtype (default float16 for legacy callers).
baselineFiles contains days of {path, ranges: [[start, end), ...], userIds}.
These float32 files are mapped here; Node only sends metadata and recent vectors.
No database, Redis or network access.
"""
import json
import re
import sys
from collections import defaultdict
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import networkx as nx
import numpy as np

K = 5
COS = 0.5
RESOLUTION = 0.3
SHARE = 0.35
MIN_TERM_AUTHORS = 2
MIN_TOPIC_AUTHORS = 3
SEED = 1
RECENT_MS = 2 * 60 * 60 * 1000
URL_RE = re.compile(r'https?://[^\s<>()\]]+')
IMAGE_RE = re.compile(r'\.(png|jpe?g|gif|webp)$', re.I)
CLEAN_RE = re.compile(r'https?://\S+|@[\w.-]+(@[\w.-]+)?|:[a-zA-Z0-9_+-]+:|\$\[[^\]]*\]|#[^\s#]+|\s')
# Bound working memory while preserving exact cosine thresholds and nearest neighbors.
MATRIX_BATCH = 256


TREND_DUP_JACCARD = 0.3
TREND_DUP_EXTRA_WEIGHT = 0.1
TREND_CONTENT_COS = 0.45
TREND_CONTENT_BURST = 3.0
TREND_CONTENT_MIN_OTHERS = 2
TREND_CONTENT_MIN_BASE_DAYS = 3
TREND_CONTENT_SEED_MIN_LENGTH = 10
TREND_CONTENT_KNN = 5
TREND_CONTENT_RESOLUTION = 0.3
TREND_CONTENT_PULL_COS = 0.6
TREND_CONTENT_PULL_MIN = 2
TREND_CONTENT_PULL_MIN_LENGTH = 15
CONTENT_CLEAN_RE = re.compile(r'https?://\S+|@[\w.-]+(@[\w.-]+)?|:[a-zA-Z0-9_+-]+:|\$\[[^\s\]]*|\]|<\/?[a-z]+>|[#＃][^\s#＃]+|\s')
TAG_GAMES = {'shindanmaker', 'fediqb', 'クイズメーカー', 'mewk', 'marshmallow', 'peing', 'odaibako'}


def shingles(text):
    clean = re.sub(CONTENT_CLEAN_RE.pattern.rsplit('|', 1)[0], '', text or '')
    clean = re.sub(r'[0-9０-９.,%％]+', '0', clean)
    clean = re.sub(r'[\s、。！!？?「」『』()（）*＊~〜ー…・,，:：]', '', clean)
    return {clean[i:i + 3] for i in range(len(clean) - 2)}


def effective_authors(notes, play_tags=True):
    by = defaultdict(list)
    tags = defaultdict(set)
    for note in notes:
        user = note['userId']
        by[user].append(shingles(note.get('text')))
        if play_tags:
            for tag in list(note.get('tags') or []) + re.findall(r'[#＃]([^\s#＃]+)', note.get('text') or ''):
                if tag.lower() in TAG_GAMES or len(re.findall(r'[\u3041-\u309f]', tag)) >= 3:
                    tags[user].add(tag.lower())
    users = list(by)
    parents = list(range(len(users)))

    def root(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i

    for a, ua in enumerate(users):
        for b in range(a + 1, len(users)):
            if root(a) == root(b):
                continue
            ub = users[b]
            if tags[ua] & tags[ub] or any(len(x | y) and len(x & y) / len(x | y) >= TREND_DUP_JACCARD
                                        for x in by[ua] for y in by[ub]):
                parents[root(b)] = root(a)
    groups = len({root(i) for i in range(len(users))})
    return round(groups + TREND_DUP_EXTRA_WEIGHT * (len(users) - groups), 1)


def centered(raw, mean):
    matrix = np.asarray(raw, dtype=np.float32).copy()
    if len(matrix):
        matrix -= np.asarray(mean, dtype=np.float32) if mean is not None else matrix.mean(axis=0)
        matrix /= np.maximum(np.linalg.norm(matrix, axis=1, keepdims=True), 1e-9)
    return matrix


def baseline_vectors(files, dim):
    chunks = []
    users = []
    for entry in files:
        mapped = np.memmap(entry['path'], dtype='<f4', mode='r').reshape(-1, dim)
        count = 0
        for start, end in entry['ranges']:
            if not 0 <= start < end <= len(mapped):
                raise ValueError('Invalid baseline row range')
            chunks.append(mapped[start:end])
            count += end - start
        if count != len(entry['userIds']):
            raise ValueError('Invalid baseline authors')
        users.extend(entry['userIds'])
    return np.concatenate(chunks), np.asarray(users)


def build_content_topics(inp, raw):
    """All vectors share meanVec; missing baseline windows are never treated as zero."""
    files = inp.get('baselineFiles')
    days = files if files is not None else inp.get('baselineDays', [])
    if len(days) < TREND_CONTENT_MIN_BASE_DAYS:
        return []
    now = inp['now']
    notes = sorted((n for n in inp['notes'] if n.get('embeddingIndex') is not None
                    and now - 6 * 3600000 <= n['createdAt'] < now
                    and len(CONTENT_CLEAN_RE.sub('', n.get('text') or '')) >= TREND_CONTENT_SEED_MIN_LENGTH),
                   key=lambda n: (n['createdAt'], n['id']))
    if len(notes) < 2:
        return []
    mean = inp.get('meanVec')
    if mean is None and files is not None:
        # Preserve a shared center even before the model's meanVec is available.
        total, count = raw.sum(axis=0, dtype=np.float64), len(raw)
        for day in files:
            vectors, _ = baseline_vectors(day, raw.shape[1])
            total += vectors.sum(axis=0, dtype=np.float64)
            count += len(vectors)
        mean = total / count
    matrix = centered(raw, mean)
    recent = matrix[[n['embeddingIndex'] for n in notes]]
    users = np.asarray([n['userId'] for n in notes])

    def counts(left, right, right_users, left_users):
        result = []
        for start in range(0, len(left), MATRIX_BATCH):
            similarities = left[start:start + MATRIX_BATCH] @ right.T
            result.extend(len(set(right_users[row >= TREND_CONTENT_COS]) - {me})
                          for row, me in zip(similarities, left_users[start:start + MATRIX_BATCH]))
        return np.asarray(result)

    n_now = counts(recent, recent, users, users)
    eligible = np.flatnonzero(n_now >= TREND_CONTENT_MIN_OTHERS)
    if len(eligible) < 2:
        return []
    base_counts = []
    for day in days:
        if files is not None:
            vectors, base_users = baseline_vectors(day, raw.shape[1])
            base = centered(vectors, mean)
        else:
            base = matrix[[n['embeddingIndex'] for n in day]]
            base_users = np.asarray([n['userId'] for n in day])
        base_counts.append(counts(recent[eligible], base, base_users, users[eligible]))
    baseline = np.median(base_counts, axis=0)
    seeds = eligible[(n_now[eligible] + 1) / (baseline + 1) >= TREND_CONTENT_BURST]
    if len(seeds) < 2:
        return []
    graph = nx.Graph()
    graph.add_nodes_from(seeds.tolist())
    similarities = recent[seeds] @ recent[seeds].T
    np.fill_diagonal(similarities, -1)
    k = min(TREND_CONTENT_KNN, len(seeds) - 1)
    nearest = np.argpartition(-similarities, k - 1, axis=1)[:, :k]
    for a, others in enumerate(nearest):
        for b in others:
            if similarities[a, b] >= TREND_CONTENT_COS:
                graph.add_edge(int(seeds[a]), int(seeds[b]), weight=float(similarities[a, b]))
    positions = {notes[i]['id']: int(i) for i in seeds}
    for i in seeds:
        for parent in links(notes[i]):
            if parent in positions:
                graph.add_edge(int(i), positions[parent], weight=1.0)
    communities = (nx.community.louvain_communities(graph, weight='weight', resolution=TREND_CONTENT_RESOLUTION, seed=SEED)
                   if graph.number_of_edges() else [{i} for i in graph])
    rest = [i for i in range(len(notes)) if i not in set(seeds)
            and len(CONTENT_CLEAN_RE.sub('', notes[i].get('text') or '')) >= TREND_CONTENT_PULL_MIN_LENGTH]
    topics = []
    for community in communities:
        if len(community) < 2:
            continue
        members = sorted(community)
        for start in range(0, len(rest), MATRIX_BATCH):
            batch = rest[start:start + MATRIX_BATCH]
            hits = np.count_nonzero(recent[batch] @ recent[sorted(community)].T >= TREND_CONTENT_PULL_COS, axis=1)
            members.extend(i for i, count in zip(batch, hits) if count >= TREND_CONTENT_PULL_MIN)
        posts = [notes[i] for i in members]
        authors = effective_authors(posts)
        if authors < MIN_TOPIC_AUTHORS:
            continue
        center = recent[members].mean(axis=0)
        center /= max(float(np.linalg.norm(center)), 1e-9)
        topics.append({'origin': 'content', 'terms': [], 'noteIds': [n['id'] for n in posts],
                       'authors6h': authors, 'authors2h': effective_authors([n for n in posts if n['createdAt'] >= now - RECENT_MS]),
                       'center': center.tolist()})
    return topics


def urls(text):
    result = set()
    for value in URL_RE.findall(text or ''):
        value = value.rstrip('/.,、。')
        try:
            parts = urlsplit(value)
            if IMAGE_RE.search(parts.path):
                continue
            query = [(key, val) for key, val in parse_qsl(parts.query, keep_blank_values=True)
                     if not key.startswith('utm_') and key not in ('s', 't', 'si', 'ref', 'feature')]
            result.add(urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment)).rstrip('/.,、。'))
        except ValueError:
            continue
    return sorted(result)


def links(note):
    return [value for value in (note.get('replyId'), note.get('renoteId') if note.get('text') else None) if value]


def build_topics(inp, raw):
    constants = inp.get('constants', {})
    k = int(constants.get('k', K))
    cos = float(constants.get('cos', COS))
    resolution = float(constants.get('resolution', RESOLUTION))
    share = float(constants.get('share', SHARE))
    min_term = int(constants.get('minTermAuthors', MIN_TERM_AUTHORS))
    min_topic = int(constants.get('minTopicAuthors', MIN_TOPIC_AUTHORS))
    input_notes = inp['notes']
    seeds = [note for note in input_notes if note.get('source', 'seed') == 'seed']
    seed_ids = {note['id'] for note in seeds}
    have_all = [note for note in input_notes if note.get('embeddingIndex') is not None]
    matrix = np.empty((0, raw.shape[1]), dtype=np.float32)
    positions = {}
    if have_all:
        matrix = raw[[note['embeddingIndex'] for note in have_all]]
        mean = inp.get('meanVec')
        matrix -= np.asarray(mean, dtype=np.float32) if mean is not None else matrix.mean(axis=0)
        matrix /= np.maximum(np.linalg.norm(matrix, axis=1, keepdims=True), 1e-9)
        positions = {note['id']: i for i, note in enumerate(have_all)}
    retained = set(seed_ids)
    retained.update(note['id'] for note in input_notes if note.get('source') == 'link')
    candidates = sorted((note for note in input_notes if note.get('source') == 'embedding'
                         and note['id'] in positions
                         and len(CLEAN_RE.sub('', note.get('text') or '')) >= int(constants.get('expandMinLength', 15))),
                        key=lambda note: note['createdAt'], reverse=True)[:int(constants.get('expandMax', 8000))]
    seed_positions = [positions[note['id']] for note in seeds if note['id'] in positions]
    min_seeds = int(constants.get('expandMinSeeds', 2))
    if len(seed_positions) >= min_seeds:
        seed_matrix = matrix[seed_positions]
        for start in range(0, len(candidates), MATRIX_BATCH):
            batch = candidates[start:start + MATRIX_BATCH]
            similarities = matrix[[positions[note['id']] for note in batch]] @ seed_matrix.T
            hits = np.count_nonzero(similarities >= float(constants.get('expandCos', 0.6)), axis=1)
            retained.update(note['id'] for note, count in zip(batch, hits) if count >= min_seeds)
    notes = [note for note in input_notes if note['id'] in retained]
    if not notes:
        return []
    by_id = {note['id']: note for note in notes}
    parents = {note['id']: note for note in inp.get('parents', [])}
    graph = nx.Graph()
    graph.add_nodes_from(by_id)
    for note in notes:
        for parent in links(note):
            if parent in by_id:
                graph.add_edge(note['id'], parent, weight=1.0)
            graph.add_edge(note['id'], 'p:' + parent, weight=1.0)
            for grandparent in links(parents.get(parent, {})):
                graph.add_edge('p:' + parent, 'p:' + grandparent, weight=1.0)
        for url in urls(note.get('text')):
            graph.add_edge(note['id'], 'u:' + url, weight=1.0)
    graph.remove_nodes_from([node for node in graph if node not in by_id and graph.degree(node) < 2])
    have = [note for note in notes if note.get('embeddingIndex') is not None]
    vectors = {}
    if have:
        matrix = matrix[[positions[note['id']] for note in have]]
        vectors = {note['id']: matrix[i] for i, note in enumerate(have)}
        if len(have) > 1:
            neighbors = min(k, len(have) - 1)
            for start in range(0, len(have), MATRIX_BATCH):
                similarities = matrix[start:start + MATRIX_BATCH] @ matrix.T
                for local in range(len(similarities)):
                    similarities[local, start + local] = -np.inf
                nearest = np.argpartition(-similarities, neighbors - 1, axis=1)[:, :neighbors]
                for local, others in enumerate(nearest):
                    for b in others:
                        if similarities[local, b] >= cos:
                            graph.add_edge(have[start + local]['id'], have[b]['id'], weight=float(similarities[local, b]))
    # Louvain divides by total edge weight; isolated notes each form a community.
    communities = (nx.community.louvain_communities(graph, weight='weight', resolution=resolution, seed=SEED)
                   if graph.number_of_edges() else [{node} for node in graph])
    community_of = {node: i for i, community in enumerate(communities) for node in community}
    assigned = defaultdict(list)
    for info in inp['terms']:
        term = info['term']
        if term.startswith('#'):
            continue
        authors = set()
        by_community = defaultdict(set)
        for note in seeds:
            if term in note['terms']:
                authors.add(note['userId'])
                by_community[community_of[note['id']]].add(note['userId'])
        if not authors:
            continue
        ci, members = max(by_community.items(), key=lambda pair: len(pair[1]))
        if len(members) >= min_term and len(members) / len(authors) >= share:
            assigned[ci].append((term, len(members), info['score']))
    result = []
    for ci, terms in assigned.items():
        members = [note for note in notes if community_of[note['id']] == ci]
        authors = effective_authors(members)
        if authors < min_topic:
            continue
        terms.sort(key=lambda term: (-term[1], -term[2]))
        embedded = [vectors[note['id']] for note in members if note['id'] in vectors]
        center = None
        if embedded:
            center_vec = np.mean(embedded, axis=0)
            norm = np.linalg.norm(center_vec)
            center = (center_vec / max(float(norm), 1e-9)).tolist()
        result.append({
            'terms': [term[0] for term in terms],
            'noteIds': [note['id'] for note in members],
            'origin': 'term',
            'authors6h': authors,
            'authors2h': effective_authors([note for note in members if note['createdAt'] >= inp['now'] - RECENT_MS]),
            'center': center,
        })
    return result


def main():
    with open(sys.argv[1], encoding='utf8') as handle:
        inp = json.load(handle)
    raw = np.fromfile(sys.argv[2], dtype=inp.get('embeddingDtype', '<f2')).astype(np.float32)
    dim = int(inp['dim'])
    raw = raw.reshape(-1, dim) if dim else np.empty((0, 0), dtype=np.float32)
    with open(sys.argv[3], 'w', encoding='utf8') as handle:
        json.dump({'topics': build_topics(inp, raw) + build_content_topics(inp, raw)}, handle, ensure_ascii=False, allow_nan=False)


if __name__ == '__main__':
    main()
