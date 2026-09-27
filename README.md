# WebAnnotate-Motion+

Ferramenta web **privacy-preserving** e **human-in-the-loop** para anotação temporal de atividades humanas em vídeos.

A versão **0.3.0** acrescenta um segundo analisador baseado em **pose corporal no navegador**, mantendo o detector por diferença de quadros como baseline explicável. O objetivo é permitir comparação experimental entre métodos automáticos e uma referência manual sem enviar o vídeo ao backend.

## Artefato científico e Zenodo

O **WebAnnotate-Motion+ v0.3.0** tem um depósito versionado preparado no **Zenodo**, com o DOI de versão **[10.5281/zenodo.23002986](https://doi.org/10.5281/zenodo.23002986)**. **O DOI foi reservado, mas o registro ainda não está público**; a disponibilidade do artefato deve ser confirmada após a publicação do depósito. Este repositório reúne o código em desenvolvimento, enquanto o depósito no Zenodo destina-se à preservação de uma versão identificável para citação e reprodução científica.

O pacote da versão científica deve incluir o código-fonte correspondente à v0.3.0, a licença MIT, o `README.md`, `requirements.txt`, `Dockerfile`, `docker-compose.yml`, `Makefile`, a amostra sintética em `samples/` e os testes em `tests/`. Os comandos de execução e validação estão documentados abaixo. Para reproduzir a versão citada no artigo, utilize os arquivos efetivamente depositados no Zenodo, em vez de depender de alterações posteriores na branch `main` ou de uma instância pública da aplicação.

**Citação sugerida após a publicação:** *WebAnnotate-Motion+ v0.3.0* (artefato de software), Zenodo, DOI: [10.5281/zenodo.23002986](https://doi.org/10.5281/zenodo.23002986). Consulte o registro publicado para obter a lista definitiva de autores, a data e os metadados de citação.

A execução da aplicação não exige uma instância pública hospedada, mas a operação **totalmente offline não está garantida**: a análise por pose carrega inicialmente dependências Web/WASM e o modelo MediaPipe de fontes externas. A demonstração com a amostra sintética e os testes de software permitem verificar funcionalidades; **não representam um estudo controlado com anotadores nem demonstram ganhos de produtividade**.

## Funcionalidades

- vídeo local ou amostra sintética;
- anotação manual com atalhos `I` e `O`;
- edição de rótulos e intervalos;
- linha do tempo com segmentos sobrepostos;
- persistência em SQLite;
- baseline por diferença visual entre quadros;
- **MediaPipe Pose Landmarker** carregado sob demanda no navegador;
- deslocamento corporal calculado a partir de landmarks de ombros, braços, quadris, joelhos e tornozelos;
- limiar manual ou adaptativo para ambos os analisadores;
- overlay do esqueleto estimado sobre o vídeo;
- sugestões separadas por origem: `motion-suggestion` e `pose-suggestion`;
- workflow `suggested → accepted/rejected`;
- confiança por sugestão;
- métricas de cobertura, aceitação e confiança;
- **IoU, Precision, Recall e F1 temporais** contra segmentos manuais de referência;
- registro de cada execução de análise;
- exportação JSON schema `0.3` e CSV;
- migração automática de bancos 0.1/0.2;
- execução local ou via Docker.

## Privacidade

O backend não possui endpoint de upload de vídeo. Para arquivos selecionados localmente, os bytes permanecem no navegador.

Na análise por pose, o navegador obtém a biblioteca Web/WASM e o modelo Pose Landmarker de fontes públicas do MediaPipe/Google. Esses downloads são dependências do cliente; **os quadros do vídeo não são enviados para inferência remota**.

O servidor armazena somente:

- nome e duração do vídeo;
- anotações temporais e rótulos;
- origem, confiança e estado de revisão;
- decisões humanas;
- parâmetros, duração e métricas das execuções automáticas.

## Como demonstrar a v0.3

1. Clique em **Usar vídeo sintético** ou escolha um vídeo local.
2. Crie um ou mais segmentos manuais de referência usando `I` e `O`.
3. Em **Assistência automática**, selecione **Pose corporal (MediaPipe)**.
4. Mantenha o limiar **Adaptativo** e execute **Analisar pose**.
5. Observe os landmarks/esqueleto sobre o vídeo.
6. Compare os segmentos verdes de pose com as anotações manuais.
7. Veja F1 e IoU temporais no painel de métricas.
8. Aceite, rejeite ou edite as sugestões.
9. Troque o analisador para **Diferença de quadros (baseline)** e repita para comparação.
10. Exporte JSON/CSV.

## Execução local

Requer Python 3.11 ou superior.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Abra `http://localhost:8000`.

API: `http://localhost:8000/docs`.

## Docker

```bash
docker compose up --build
```

## Testes

```bash
make test
```

Ou individualmente:

```bash
pytest -q
node --check static/app.js
node --check static/pose-analyzer.js
node --check static/temporal-metrics.js
node tests/test_temporal_metrics.mjs
```

## Endpoints principais

- `GET /api/health`
- `POST /api/projects`
- `GET/PATCH/DELETE /api/projects/{id}`
- `POST /api/projects/{id}/annotations`
- `POST /api/projects/{id}/annotations/bulk`
- `PATCH/DELETE /api/annotations/{id}`
- `POST /api/projects/{id}/analysis-runs`
- `GET /api/projects/{id}/analysis-runs`
- `GET /api/projects/{id}/metrics`
- `GET /api/projects/{id}/export?format=json|csv`

## Limitações atuais

- o detector por pose segmenta **movimento corporal**, mas ainda não classifica semanticamente a ação;
- F1/IoU avaliam sobreposição temporal com todas as anotações manuais aceitas, portanto a referência deve ser preparada de forma consistente;
- o carregamento inicial do MediaPipe e do modelo requer acesso às dependências externas configuradas no cliente;
- vídeos com múltiplas pessoas ainda são tratados com `numPoses = 1`;
- colaboração multiusuário e concordância entre anotadores permanecem fora do escopo da v0.3.

## Próximas evoluções

- classificação semântica de atividades a partir dos descritores de pose;
- suporte opcional a múltiplas pessoas;
- importação de ground truth de datasets públicos;
- métricas por classe e por anotador;
- empacotamento local das dependências MediaPipe para operação totalmente offline;
- estudo controlado de ganho de tempo entre anotação manual e assistida.

## Licença

MIT.
