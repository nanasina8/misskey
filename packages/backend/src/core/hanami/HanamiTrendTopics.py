#!/usr/bin/env python3
"""Pure topic builder: INPUT_JSON EMBEDDINGS_FP16 OUTPUT_JSON.

notes: [{id, userId, createdAt (epoch milliseconds), replyId, renoteId,
text, terms, source (seed/link/embedding), embeddingIndex (nullable)}], parents: [{id, replyId, renoteId,
text}], terms: [{term, score}], dim, meanVec (nullable), now, constants.
Embeddings are little-endian float16 vectors in embeddingIndex order.
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
        authors = {note['userId'] for note in members}
        if len(authors) < min_topic:
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
            'authors6h': len(authors),
            'authors2h': len({note['userId'] for note in members if note['createdAt'] >= inp['now'] - RECENT_MS}),
            'center': center,
        })
    return result


def main():
    with open(sys.argv[1], encoding='utf8') as handle:
        inp = json.load(handle)
    raw = np.fromfile(sys.argv[2], dtype='<f2').astype(np.float32)
    dim = int(inp['dim'])
    raw = raw.reshape(-1, dim) if dim else np.empty((0, 0), dtype=np.float32)
    with open(sys.argv[3], 'w', encoding='utf8') as handle:
        json.dump({'topics': build_topics(inp, raw)}, handle, ensure_ascii=False, allow_nan=False)


if __name__ == '__main__':
    main()
