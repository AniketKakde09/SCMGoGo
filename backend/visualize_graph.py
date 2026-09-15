from pathlib import Path
import networkx as nx
from graph import GRAPH_PATH, build_dependency_graph, save_graph

ROOT = Path(__file__).resolve().parent
PNG_PATH = ROOT / 'vectorstore' / 'dependency_graph.png'


def main():
    graph = build_dependency_graph()
    save_graph(graph)
    print(f'Nodes: {graph.number_of_nodes()}')
    print(f'Edges: {graph.number_of_edges()}')
    print(f'Cycles: {list(nx.simple_cycles(graph))}')
    print(f'GraphML: {GRAPH_PATH}')

    try:
        import matplotlib.pyplot as plt
    except ImportError:
        print('matplotlib not installed; skipping PNG. NetworkX graph is still available.')
        return

    pos = nx.spring_layout(graph, seed=42)
    plt.figure(figsize=(15, 11))
    nx.draw_networkx_nodes(graph, pos, node_size=900)
    nx.draw_networkx_edges(graph, pos, arrows=True, arrowsize=16, alpha=0.7)
    labels = {n: n for n in graph.nodes}
    nx.draw_networkx_labels(graph, pos, labels=labels, font_size=7)
    plt.title('Foreman Ticket Dependency Graph')
    plt.axis('off')
    plt.tight_layout()
    plt.savefig(PNG_PATH, dpi=160)
    plt.close()
    print(f'PNG: {PNG_PATH}')

if __name__ == '__main__':
    main()
