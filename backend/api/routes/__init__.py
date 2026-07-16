from api.routes import artifacts, catalog, engagements, human_tasks, workflow_runs

ALL_ROUTERS = [
    catalog.router,
    engagements.router,
    artifacts.router,
    workflow_runs.router,
    human_tasks.router,
]
