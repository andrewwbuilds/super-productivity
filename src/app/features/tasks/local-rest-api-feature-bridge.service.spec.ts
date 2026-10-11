import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { MockStore, provideMockStore } from '@ngrx/store/testing';
import { of } from 'rxjs';
import { IssueService } from '../issue/issue.service';
import { ProjectService } from '../project/project.service';
import { TaskRepeatCfg } from '../task-repeat-cfg/task-repeat-cfg.model';
import { TaskRepeatCfgService } from '../task-repeat-cfg/task-repeat-cfg.service';
import { LocalRestApiFeatureBridgeService } from './local-rest-api-feature-bridge.service';
import { addSubTask } from './store/task.actions';
import { DEFAULT_TASK, Task, TaskWithSubTasks } from './task.model';
import { TaskService } from './task.service';

describe('LocalRestApiFeatureBridgeService', () => {
  let service: LocalRestApiFeatureBridgeService;
  let taskServiceMock: jasmine.SpyObj<TaskService>;
  let issueServiceMock: jasmine.SpyObj<IssueService>;
  let repeatCfgServiceMock: jasmine.SpyObj<TaskRepeatCfgService>;
  let dialogOpen: jasmine.Spy;
  let dispatchSpy: jasmine.Spy;

  beforeEach(() => {
    taskServiceMock = jasmine.createSpyObj<TaskService>('TaskService', [
      'createNewTaskWithDefaults',
      'getByIdWithSubTaskData$',
      'moveToProject',
      'getTasksWithSubTasksByRepeatCfgId$',
      'getArchiveTasksForRepeatCfgId',
      'updateArchiveTasks',
    ]);
    issueServiceMock = jasmine.createSpyObj<IssueService>('IssueService', ['issueLink']);
    repeatCfgServiceMock = jasmine.createSpyObj<TaskRepeatCfgService>(
      'TaskRepeatCfgService',
      ['getTaskRepeatCfgByIdAllowUndefined$', 'updateTaskRepeatCfg'],
    );
    dialogOpen = jasmine.createSpy('open');

    TestBed.configureTestingModule({
      providers: [
        LocalRestApiFeatureBridgeService,
        { provide: TaskService, useValue: taskServiceMock },
        { provide: IssueService, useValue: issueServiceMock },
        { provide: TaskRepeatCfgService, useValue: repeatCfgServiceMock },
        { provide: ProjectService, useValue: { getByIdOnce$: () => of({ id: 'p2' }) } },
        { provide: MatDialog, useValue: { open: dialogOpen } },
        provideMockStore(),
      ],
    });

    service = TestBed.inject(LocalRestApiFeatureBridgeService);
    dispatchSpy = spyOn(TestBed.inject(MockStore), 'dispatch');
  });

  it('should delegate issueLink to the issue service', async () => {
    issueServiceMock.issueLink.and.returnValue(
      Promise.resolve('https://github.com/o/r/issues/42'),
    );

    await expectAsync(service.issueLink('GITHUB', '42', 'provider-1')).toBeResolvedTo(
      'https://github.com/o/r/issues/42',
    );
    expect(issueServiceMock.issueLink).toHaveBeenCalledOnceWith(
      'GITHUB',
      '42',
      'provider-1',
    );
  });

  it('should add a subtask that skips short syntax', () => {
    taskServiceMock.createNewTaskWithDefaults.and.returnValue({
      id: 'literal-sub',
      title: 'Child #x',
    } as Task);

    const id = service.addLiteralSubTask('parent-1', { title: 'Child #x' });

    expect(id).toBe('literal-sub');
    // Same arguments TaskService.addSubTaskTo passes — incl. the dueDay key,
    // whose presence stops a Today context from giving the subtask a due date.
    const factoryArgs = taskServiceMock.createNewTaskWithDefaults.calls.mostRecent()
      .args[0] as { title: string; additional: Record<string, unknown> };
    expect(factoryArgs.title).toBe('Child #x');
    expect('dueDay' in factoryArgs.additional).toBe(true);
    expect(factoryArgs.additional.title).toBe('Child #x');
    const action = dispatchSpy.calls.mostRecent().args[0];
    expect(action.type).toBe(addSubTask.type);
    expect(action.task.id).toBe('literal-sub');
    expect(action.parentId).toBe('parent-1');
    expect(action.isIgnoreShortSyntax).toBe(true);
  });

  // #10675: a REST move runs the real move service, so the repeat config and
  // every instance (archived ones included) follow the task, unconfirmed.
  describe('moveTaskToProject', () => {
    const instance = (id: string): TaskWithSubTasks =>
      ({
        ...DEFAULT_TASK,
        id,
        projectId: 'p1',
        repeatCfgId: 'cfg',
        subTasks: [],
      }) as TaskWithSubTasks;
    const task = instance('t1');
    const otherInstance = instance('t2');
    const archivedInstance = { ...instance('a1'), subTaskIds: ['a1-sub'] } as Task;

    beforeEach(() => {
      taskServiceMock.getTasksWithSubTasksByRepeatCfgId$.and.returnValue(
        of([task, otherInstance]),
      );
      taskServiceMock.getArchiveTasksForRepeatCfgId.and.resolveTo([archivedInstance]);
      taskServiceMock.updateArchiveTasks.and.resolveTo();
      repeatCfgServiceMock.getTaskRepeatCfgByIdAllowUndefined$.and.returnValue(
        of({ id: 'cfg', projectId: 'p1' } as TaskRepeatCfg),
      );
    });

    it('should move the repeat config and all instances without asking', async () => {
      taskServiceMock.getByIdWithSubTaskData$.and.returnValue(of(task));

      await service.moveTaskToProject('t1', 'p2');

      expect(dialogOpen).not.toHaveBeenCalled();
      expect(repeatCfgServiceMock.updateTaskRepeatCfg).toHaveBeenCalledOnceWith('cfg', {
        projectId: 'p2',
      });
      expect(taskServiceMock.moveToProject).toHaveBeenCalledWith(task, 'p2');
      expect(taskServiceMock.moveToProject).toHaveBeenCalledWith(otherInstance, 'p2');
      expect(taskServiceMock.updateArchiveTasks).toHaveBeenCalledOnceWith([
        { id: 'a1', changes: { projectId: 'p2' } },
        { id: 'a1-sub', changes: { projectId: 'p2' } },
      ]);
    });

    it('should do nothing for a task that no longer exists', async () => {
      taskServiceMock.getByIdWithSubTaskData$.and.returnValue(of(undefined));

      await service.moveTaskToProject('gone', 'p2');

      expect(taskServiceMock.moveToProject).not.toHaveBeenCalled();
      expect(repeatCfgServiceMock.updateTaskRepeatCfg).not.toHaveBeenCalled();
    });
  });
});
